/**
 * safety/assertCheckpointMatchesCommit.ts
 *
 * Pre-flight sanity guard: verifies that the sender's ShieldedCheckpoint state,
 * when accumulated with any pending inbox notes, produces a Pedersen commitment
 * that matches the on-chain commitment slot.
 *
 * If they don't match, one of the following has happened:
 *   1. Old BatchClaimCTA bug: checkpoint blinding was stored as
 *      (oldBlinding + Σnote_blindings + newBlinding) instead of just newBlinding.
 *   2. sendTip/unwrap without cursor fix: pending notes were included in newBalance
 *      but the cursor was not advanced — causing double-count on next op.
 *   3. External state corruption (race condition, partial tx).
 *
 * Throws a structured CheckpointDivergenceError with diagnostics.
 * Returns void if the state is coherent.
 */

import { ethers } from "ethers";
import { decryptSnapshot } from "../crypto/checkpoint-schema";
import { decryptNote } from "../crypto/note-helpers";
import { computeCommitment } from "../primitives/pedersen";
import { SHIELDED_INBOX_ADDRESS, SHIELDED_CHECKPOINT_ADDRESS, FLOW_EVM_RPC } from "../network/contracts";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class CheckpointDivergenceError extends Error {
  readonly code = "CHECKPOINT_DIVERGENCE";
  readonly diagnostics: {
    coa:             string;
    tokenAddress:    string;
    cpBalance:       bigint;
    cpBlinding:      bigint;
    sumPendingAmts:  bigint;
    sumPendingBlinds: bigint;
    computedCommit:  { x: bigint; y: bigint };
    onChainCommit:   { x: bigint; y: bigint };
    pendingCount:    number;
    cursor:          bigint;
  };

  constructor(msg: string, diag: CheckpointDivergenceError["diagnostics"]) {
    super(msg);
    this.name = "CheckpointDivergenceError";
    this.diagnostics = diag;
  }
}

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const CHECKPOINT_ABI = new ethers.Interface([
  "function read(address token) view returns (tuple(bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, uint64 lastConsumedNoteIndex, uint64 lastUpdatedBlock, uint64 version) cp)",
]);

const INBOX_ABI = new ethers.Interface([
  "function count(address user) view returns (uint256)",
  "function peek(address user, uint256 offset, uint256 limit) view returns (tuple(bytes ciphertext, uint256 ephPubkeyX, uint256 ephPubkeyY, address depositor, uint64 blockNumber)[] notes)",
]);

const JANUS_ABI = new ethers.Interface([
  "function commitments(address user) view returns (uint256 x, uint256 y)",
]);

const BABYJUB_SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AssertCheckpointOpts {
  /** EVM RPC URL. Defaults to Flow testnet. */
  rpc?:             string;
  /** ShieldedCheckpoint contract address. Defaults to SDK constant. */
  checkpointAddr?:  string;
  /** ShieldedInbox contract address. Defaults to SDK constant. */
  inboxAddr?:       string;
  /** Janus token contract address (for reading on-chain commitment). */
  janusTokenAddr:   string;
  /** BabyJub memo private key for ECIES decryption. */
  memoPrivkey:      bigint;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Assert that the caller's checkpoint state matches the on-chain commitment.
 *
 * Steps:
 *   1. Read ShieldedCheckpoint.read(tokenAddress) — decrypt snapshot.
 *   2. Read ShieldedInbox.peek(coa) — filter by depositor + cursor.
 *   3. Accumulate pending note deltas.
 *   4. Compute Pedersen(cpBalance + Σpending, cpBlinding + Σpending_blinds).
 *   5. Compare to JanusToken.commitments(coa).
 *
 * Throws CheckpointDivergenceError if mismatched.
 *
 * @param coa           Sender's EVM address (commitment owner).
 * @param tokenAddress  EVM proxy address of the Janus token.
 * @param opts          Options including RPC, contract addresses, privkey.
 */
export async function assertCheckpointMatchesCommit(
  coa: string,
  tokenAddress: string,
  opts: AssertCheckpointOpts,
): Promise<void> {
  const rpc            = opts.rpc            ?? FLOW_EVM_RPC;
  const checkpointAddr = opts.checkpointAddr ?? SHIELDED_CHECKPOINT_ADDRESS;
  const inboxAddr      = opts.inboxAddr      ?? SHIELDED_INBOX_ADDRESS;

  const provider    = new ethers.JsonRpcProvider(rpc);
  const coaLower    = coa.toLowerCase();
  const tokenLower  = tokenAddress.toLowerCase();

  // ── 1. Read checkpoint ────────────────────────────────────────────────────
  let cpBalance  = 0n;
  let cpBlinding = 0n;
  let cursor     = 0n;

  try {
    const readCalldata = CHECKPOINT_ABI.encodeFunctionData("read", [tokenAddress]);
    const raw = await provider.call({ to: checkpointAddr, from: coaLower, data: readCalldata });
    if (raw && raw !== "0x" && raw.length > 2) {
      const [cp] = CHECKPOINT_ABI.decodeFunctionResult("read", raw);
      cursor = BigInt(cp.lastConsumedNoteIndex);
      const encSnap = ethers.getBytes(cp.encryptedSnapshot as string);
      if (encSnap.length > 0) {
        const snap = await decryptSnapshot(encSnap, { x: BigInt(cp.ephPubkeyX), y: BigInt(cp.ephPubkeyY) }, opts.memoPrivkey);
        if (snap) {
          cpBalance  = snap.balance;
          cpBlinding = snap.blinding;
        }
      }
    }
  } catch {
    // No checkpoint yet — cpBalance/cpBlinding stay 0n, cursor stays 0n
  }

  // ── 2. Read inbox + headOffset ────────────────────────────────────────────
  let headOffset = 0n;
  try {
    const headSlot = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [coaLower, 1]),
    );
    const headRaw = await provider.getStorage(inboxAddr, headSlot);
    headOffset = BigInt(headRaw);
  } catch { /* headOffset stays 0n */ }

  let allNotes: Array<{
    ciphertext: Uint8Array;
    ephPubkeyX: bigint;
    ephPubkeyY: bigint;
    depositor:  string;
  }> = [];
  try {
    const cntCalldata = INBOX_ABI.encodeFunctionData("count", [coaLower]);
    const cntRaw      = await provider.call({ to: inboxAddr, data: cntCalldata });
    const [cnt]       = INBOX_ABI.decodeFunctionResult("count", cntRaw);
    const n           = BigInt(cnt);
    if (n > 0n) {
      const peekCalldata = INBOX_ABI.encodeFunctionData("peek", [coaLower, 0n, n]);
      const peekRaw      = await provider.call({ to: inboxAddr, data: peekCalldata });
      const [rawNotes]   = INBOX_ABI.decodeFunctionResult("peek", peekRaw);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      allNotes = (rawNotes as any[]).map(r => ({
        ciphertext: ethers.getBytes(r.ciphertext as string),
        ephPubkeyX: BigInt(r.ephPubkeyX),
        ephPubkeyY: BigInt(r.ephPubkeyY),
        depositor:  (r.depositor as string).toLowerCase(),
      }));
    }
  } catch { /* inbox unreadable — treat as empty */ }

  // ── 3. Filter + decrypt pending notes ────────────────────────────────────
  const tokenNotes = allNotes.filter(
    (n, idx) =>
      n.depositor === tokenLower &&
      headOffset + BigInt(idx) >= cursor,
  );

  let sumAmounts = 0n;
  let sumBlinds  = 0n;
  let pendingCount = 0;

  for (const n of tokenNotes) {
    try {
      const content = await decryptNote(n.ciphertext, { x: n.ephPubkeyX, y: n.ephPubkeyY }, opts.memoPrivkey);
      sumAmounts += content.amount;
      sumBlinds   = (sumBlinds + content.blinding) % BABYJUB_SUBORDER;
      pendingCount++;
    } catch { /* skip non-decryptable */ }
  }

  // ── 4. Compute expected commitment ────────────────────────────────────────
  const totalBalance  = cpBalance  + sumAmounts;
  const totalBlinding = (cpBlinding + sumBlinds) % BABYJUB_SUBORDER;
  const computedCommit = await computeCommitment(totalBalance, totalBlinding);

  // ── 5. Read on-chain commitment ───────────────────────────────────────────
  let onChainCommit = { x: 0n, y: 1n };
  try {
    const cmCalldata = JANUS_ABI.encodeFunctionData("commitments", [coa]);
    const cmRaw      = await provider.call({ to: opts.janusTokenAddr, data: cmCalldata });
    const [x, y]    = JANUS_ABI.decodeFunctionResult("commitments", cmRaw);
    onChainCommit    = { x: BigInt(x), y: BigInt(y) };
  } catch { /* leave identity */ }

  // Identity point (x=0, y=1) means slot never initialized or admin-reset.
  // With totalBalance=0 this is the expected match; otherwise it's a divergence.
  const isIdentity = onChainCommit.x === 0n && onChainCommit.y === 1n;
  if (isIdentity && totalBalance === 0n) return; // fresh slot, coherent

  if (computedCommit.x !== onChainCommit.x || computedCommit.y !== onChainCommit.y) {
    throw new CheckpointDivergenceError(
      `Checkpoint divergence for ${coa} / token ${tokenAddress}. ` +
      `Computed C_old=(${computedCommit.x.toString().slice(0, 12)}…) ` +
      `vs on-chain=(${onChainCommit.x.toString().slice(0, 12)}…). ` +
      `Likely cause: blinding accumulation bug from old claim code. ` +
      `Testnet: use adminResetCommitment. Production: contact support.`,
      { coa, tokenAddress, cpBalance, cpBlinding, sumPendingAmts: sumAmounts, sumPendingBlinds: sumBlinds, computedCommit, onChainCommit, pendingCount, cursor },
    );
  }
}
