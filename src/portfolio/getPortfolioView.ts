/**
 * portfolio/getPortfolioView.ts — Multi-token shielded portfolio snapshot.
 *
 * Reads ShieldedCheckpoint (sender balance) and ShieldedInbox (pending incoming
 * notes) for a given COA address and decrypts both with the caller's memo privkey.
 * Returns a unified PortfolioView that the drift-detection fuzz test uses to
 * compare expected vs actual on-chain state after every operation.
 *
 * v0.8.2: ShieldedCheckpoint is per-token (token address as first arg on read()).
 * ShieldedInbox is shared across all tokens; depositor field identifies the token.
 */

import { ethers } from "ethers";
import { decryptSnapshot } from "../crypto/checkpoint-schema";
import { decryptNote } from "../crypto/note-helpers";
import { computeCommitment } from "../primitives/pedersen";
import { FLOW_EVM_RPC, FLOW_CADENCE_ACCESS, CADENCE_DEPLOYER_ADDRESS } from "../network/contracts";
import { getCadenceInboxNotes } from "../inbox/CadenceInboxClient";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** All possible checkpoint health states. */
export type CheckpointHealth = "coherent" | "stale" | "corrupted" | "not_initialized" | "unknown";

export interface TokenPortfolioView {
  /** "flow" | "mockusdc" | "mockft" */
  tokenId: string;
  /** EVM identifier as stored in ShieldedCheckpoint / ShieldedInbox depositor. */
  tokenAddress: string;
  /** Decrypted balance from ShieldedCheckpoint slot. 0n if no checkpoint. */
  shielded: bigint;
  /** Sum of decrypted note amounts from ShieldedInbox filtered by this token. */
  pending: bigint;
  /** shielded + pending */
  total: bigint;
  pendingNotes: Array<{
    amount: bigint;
    blinding: bigint;
    memo?: string;
    inboxIndex: number;
  }>;
  pendingCount: number;
  /** pendingCount >= 10 — eligibility for batch claim. */
  batchEligible: boolean;
  /** Notes/slot that failed to decrypt (wrong key or garbage ciphertext). */
  decryptErrors: string[];
  /** ShieldedCheckpoint version for this (owner, token) pair. 0n if no checkpoint. */
  checkpointVersion: bigint;
  /**
   * lastConsumedNoteIndex from ShieldedCheckpoint — cursor into the shared EVM inbox.
   * Only inbox notes at absolute index >= claimedCursor are counted as pending.
   * 0n if no checkpoint yet (all notes treated as pending).
   */
  claimedCursor: bigint;
  /**
   * Where the canonical balance lives on-chain.
   *   "evm-checkpoint"      — EVM ShieldedCheckpoint (FLOW, mUSDC, wFLOW)
   *   "cadence-commitments" — Cadence JanusFT.commitments map (MockFT)
   * Informational — used by claim UI to label the source and route unwrap correctly.
   */
  sourceOfTruth: "evm-checkpoint" | "cadence-commitments";
  /**
   * True when the ShieldedCheckpoint slot for this token is uninitialized or
   * was reset by an admin call (adminResetSlot / adminBatchResetSlots).
   *
   * When freshSlot is true, callers MUST treat prevBalance, prevBlinding, and
   * prevCursor as zero regardless of any locally-cached values. Using stale
   * local state while the on-chain slot is zeroed produces a C_old mismatch
   * and the verifier will reject the transaction.
   *
   * Detection logic:
   *   - EVM tokens: checkpointVersion === 0n (no checkpoint ever written for this owner/token pair)
   *   - Cadence FT: also checkpointVersion === 0n; callers should additionally call
   *     adapter.getCommitment(cadenceAddr) and check isFreshSlotCommit(commit) for the
   *     JanusFT-side commitment.
   */
  freshSlot: boolean;
  /**
   * Checkpoint health status for this token.
   *
   *   "coherent"   — computed Pedersen(cpBalance + Σpending, cpBlinding + Σpending_blinds)
   *                  matches the on-chain commitment. All ops are safe.
   *   "stale"      — pending notes exist that haven't been absorbed into the checkpoint.
   *                  send/unwrap will absorb them automatically (cursor fix). Claim is needed
   *                  only if the user wants the pending amounts reflected in shieldedBalance.
   *   "corrupted"  — commitment mismatch even with pendingCount=0. Blinding stored incorrectly
   *                  (old BatchClaimCTA bug). Admin reset required on testnet.
   *   "unknown"    — health check failed (RPC error, etc.). Treat as stale.
   */
  checkpointHealth: "coherent" | "stale" | "corrupted" | "not_initialized" | "unknown";
  /**
   * Which operations the frontend should allow for this token right now.
   *
   * These are conservative: an op flagged false WILL fail on-chain if attempted.
   * An op flagged true may still fail for other reasons (balance, gas, etc.).
   */
  safeOpsAvailable: {
    wrap:   boolean;
    send:   boolean;
    claim:  boolean;
    unwrap: boolean;
  };
}

export interface PortfolioView {
  /** 20-byte EVM address (checksummed). */
  coa: string;
  /** Owner's Cadence account address (echoed from opts.cadenceAddress, or empty string). */
  cadenceAddress: string;
  /** Same as coa — duplicated for symmetry with cadenceAddress in UI display. */
  evmCoaAddress: string;
  tokens: { [tokenId: string]: TokenPortfolioView };
}

export interface GetPortfolioViewOpts {
  rpc: string;
  /** ShieldedCheckpoint EVM contract address. */
  checkpointAddr: string;
  /** ShieldedInbox EVM contract address. If omitted, same as checkpointAddr is NOT assumed —
   *  callers MUST pass it explicitly because the two contracts have different ABIs. */
  inboxAddr: string;
  /**
   * Tokens to query: id (stable label) + address (EVM proxy / 20-byte padded Cadence addr).
   * Optionally supply janusTokenAddr (the canonical JanusToken / JanusERC20 contract that
   * holds the on-chain commitment slot) so that getPortfolioView can compute checkpointHealth
   * via a live Pedersen comparison instead of falling back to the stale/heuristic path.
   */
  tokens: Array<{ id: string; address: string; janusTokenAddr?: string }>;
  /** BabyJub memo private key for ECIES decryption. */
  memoPrivkey: bigint;
  /**
   * Owner's Cadence account address (optional, recommended).
   * When provided it is echoed into PortfolioView.cadenceAddress and
   * is used to read the Cadence ShieldedInbox for cadence-ft tokens (MockFT).
   */
  cadenceAddress?: string;
  /**
   * Flow Cadence access node URL.
   * Used when reading the Cadence ShieldedInbox for cadence-ft tokens.
   * Defaults to FLOW_CADENCE_ACCESS (https://rest-testnet.onflow.org).
   */
  flowAccessNode?: string;
  /**
   * Cadence address where ShieldedInbox contract is deployed.
   * Defaults to CADENCE_DEPLOYER_ADDRESS (0x4b6bc58bc8bf5dcc).
   */
  cadenceInboxContractAddress?: string;
}

// ---------------------------------------------------------------------------
// ABIs (minimal surfaces for the calls we make)
// ---------------------------------------------------------------------------

const CHECKPOINT_ABI = new ethers.Interface([
  // owner-gated read — uses msg.sender check; simulate via eth_call with `from`
  "function read(address token) view returns (tuple(bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, uint64 lastConsumedNoteIndex, uint64 lastUpdatedBlock, uint64 version) cp)",
  // public metadata (no owner gate)
  "function exists(address user, address token) view returns (bool)",
  "function metadata(address user, address token) view returns (uint64 lastConsumedNoteIndex, uint64 lastUpdatedBlock, uint64 version, bool hasCheckpoint)",
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
// Main function
// ---------------------------------------------------------------------------

/**
 * Read and decrypt the full shielded portfolio for a COA address.
 *
 * For each token:
 *   1. ShieldedCheckpoint.read(token) via eth_call simulated as `from=coa` to
 *      pass the msg.sender ownership check without a real signer.
 *   2. ShieldedInbox.peek(coa, 0, count) — filter by depositor == tokenAddress.
 *   3. Decrypt each note; collect failures in decryptErrors.
 *
 * @param coa   EVM address of the COA (checkpoint owner / inbox owner).
 * @param opts  Options including RPC, contract addresses, token list, privkey.
 */
export async function getPortfolioView(
  coa: string,
  opts: GetPortfolioViewOpts,
): Promise<PortfolioView> {
  const provider = new ethers.JsonRpcProvider(opts.rpc);
  const checksummedCoa = coa.toLowerCase(); // avoid EIP-55 issues in eth_call

  // ── 1. Fetch all inbox notes once (shared across tokens) ─────────────────
  let allInboxNotes: Array<{
    ciphertext: Uint8Array;
    ephPubkeyX: bigint;
    ephPubkeyY: bigint;
    depositor: string;
    blockNumber: bigint;
    absoluteIndex: number;
  }> = [];
  try {
    const countCalldata = INBOX_ABI.encodeFunctionData("count", [checksummedCoa]);
    const countResult = await provider.call({ to: opts.inboxAddr, data: countCalldata });
    const [count] = INBOX_ABI.decodeFunctionResult("count", countResult);
    const n = BigInt(count);
    if (n > 0n) {
      // Fetch _heads[coa] via raw storage to compute correct absolute note indices.
      // peek() returns notes starting at _heads[user]+offset, so peek result[idx]
      // corresponds to absolute storage position _heads[user]+idx, NOT just idx.
      // Without this, cursor-based filtering (absoluteIndex >= lastConsumedNoteIndex)
      // is wrong whenever _heads[user] > 0 (e.g. after any previous drain operation).
      //
      // ShieldedInbox storage layout (Solidity slot order):
      //   slot 0: _inboxes  mapping(address => Note[])
      //   slot 1: _heads    mapping(address => uint256)
      // Mapping slot = keccak256(abi.encode(key, slotIndex))
      let headOffset = 0;
      try {
        const headMappingSlot = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "uint256"],
            [checksummedCoa, 1],
          ),
        );
        const headRaw = await provider.getStorage(opts.inboxAddr, headMappingSlot);
        headOffset = Number(BigInt(headRaw));
      } catch {
        // headOffset stays 0 — safe fallback (absoluteIndex may be wrong only if
        // head > 0, but the cursor filter will not spuriously hide un-consumed notes)
      }

      const peekCalldata = INBOX_ABI.encodeFunctionData("peek", [checksummedCoa, 0n, n]);
      const peekResult = await provider.call({ to: opts.inboxAddr, data: peekCalldata });
      const [rawNotes] = INBOX_ABI.decodeFunctionResult("peek", peekResult);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      allInboxNotes = (rawNotes as any[]).map((r, idx) => ({
        ciphertext: ethers.getBytes(r.ciphertext),
        ephPubkeyX: BigInt(r.ephPubkeyX),
        ephPubkeyY: BigInt(r.ephPubkeyY),
        depositor: (r.depositor as string).toLowerCase(),
        blockNumber: BigInt(r.blockNumber),
        // headOffset + idx = absolute storage position in _inboxes[user].
        // The cursor comparison (absoluteIndex >= lastConsumedNoteIndex) in the
        // per-token filter below depends on this being the true absolute index.
        absoluteIndex: headOffset + idx,
      }));
    }
  } catch (err: unknown) {
    // inbox read failure is non-fatal — we report it per-token below
    const msg = err instanceof Error ? err.message : String(err);
    // If inbox is completely inaccessible, every token will get an empty inbox.
    // Log here and continue — per-token errors will surface in decryptErrors.
    console.warn(`getPortfolioView: inbox peek failed for ${coa}: ${msg.slice(0, 120)}`);
  }

  // ── 2. Per-token: checkpoint + filtered inbox notes ───────────────────────
  const tokenViews: { [tokenId: string]: TokenPortfolioView } = {};

  for (const token of opts.tokens) {
    const tokenAddrLower = token.address.toLowerCase();
    const decryptErrors: string[] = [];

    // ── 2a. Checkpoint read ───────────────────────────────────────────────
    let shielded = 0n;
    let cpBlinding = 0n;
    let checkpointVersion = 0n;
    // Cursor: notes at absoluteIndex < lastConsumedNoteIndex have been logically
    // consumed into the shielded checkpoint and must NOT be counted as pending again.
    let lastConsumedNoteIndex = 0n;
    let isNoCheckpointSlot = false;

    try {
      const readCalldata = CHECKPOINT_ABI.encodeFunctionData("read", [token.address]);
      const readResult = await provider.call({
        to: opts.checkpointAddr,
        from: checksummedCoa,  // simulate msg.sender = COA
        data: readCalldata,
      });

      if (readResult && readResult !== "0x" && readResult.length > 2) {
        const [cp] = CHECKPOINT_ABI.decodeFunctionResult("read", readResult);
        const encSnap = ethers.getBytes(cp.encryptedSnapshot as string);
        const ephX = BigInt(cp.ephPubkeyX);
        const ephY = BigInt(cp.ephPubkeyY);
        checkpointVersion = BigInt(cp.version);
        lastConsumedNoteIndex = BigInt(cp.lastConsumedNoteIndex);

        if (encSnap.length > 0) {
          const snap = await decryptSnapshot(encSnap, { x: ephX, y: ephY }, opts.memoPrivkey);
          if (snap) {
            shielded = snap.balance;
            cpBlinding = snap.blinding;
          } else {
            decryptErrors.push(`checkpoint:decrypt_failed:token=${token.address}`);
          }
        }
        // version=0 with empty snapshot means no checkpoint yet — shielded stays 0n
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Detect NoCheckpoint custom error (selector 0x8f562fb9 = keccak256("NoCheckpoint(address,address)")[:4])
      // Also handle older selector 0x9e87fac8 and explicit name match.
      const isNoCheckpointRevert =
        msg.includes("NoCheckpoint") ||
        msg.includes("0x8f562fb9") ||
        msg.includes("0x9e87fac8");
      if (!isNoCheckpointRevert) {
        decryptErrors.push(`checkpoint:read_error:${msg.slice(0, 100)}`);
      }
      // Track NoCheckpoint for health override below.
      // isNoCheckpointSlot is declared outside this try/catch — see below.
      if (isNoCheckpointRevert) {
        isNoCheckpointSlot = true;
      }
      // shielded stays 0n; lastConsumedNoteIndex stays 0n (all notes visible)
    }

    // ── 2b. Inbox notes for this token ────────────────────────────────────
    const pendingNotes: TokenPortfolioView["pendingNotes"] = [];
    let pending = 0n;
    let sumPendingBlinds = 0n;

    // Determine if this is a Cadence FT token (e.g. MockFT) before inbox reads.
    // Heuristic: padded 8-byte Cadence address (top 12 bytes == 0, lower 8 bytes = Cadence addr).
    const isCadenceFt = /^0x0{24}[a-f0-9]{16}$/i.test(token.address);

    if (!isCadenceFt) {
      // ── EVM inbox path (FLOW, mUSDC) ────────────────────────────────────
      // Filter by depositor (identifies token) AND by cursor:
      // notes at absoluteIndex < lastConsumedNoteIndex were already consumed into
      // shielded via claimBatch / wrap / unwrap and must not be double-counted.
      const tokenNotes = allInboxNotes.filter(
        (n) =>
          n.depositor === tokenAddrLower &&
          BigInt(n.absoluteIndex) >= lastConsumedNoteIndex,
      );

      for (let i = 0; i < tokenNotes.length; i++) {
        const note = tokenNotes[i];
        try {
          const content = await decryptNote(
            note.ciphertext,
            { x: note.ephPubkeyX, y: note.ephPubkeyY },
            opts.memoPrivkey,
          );
          pending += content.amount;
          sumPendingBlinds = (sumPendingBlinds + content.blinding) % BABYJUB_SUBORDER;
          pendingNotes.push({
            amount: content.amount,
            blinding: content.blinding,
            memo: content.memo,
            inboxIndex: note.absoluteIndex,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          decryptErrors.push(`inbox[${note.absoluteIndex}]:decrypt_failed:${msg.slice(0, 80)}`);
        }
      }
    } else if (opts.cadenceAddress) {
      // ── Cadence inbox path (MockFT / cadence-ft tokens) ─────────────────
      // JanusFT.shieldedTransfer writes to the recipient's Cadence ShieldedInbox,
      // NOT the EVM ShieldedInbox. The inbox head pointer on-chain tracks what
      // has been drained; peek() returns only UNREAD (pending) notes — no
      // external cursor is needed here (unlike the EVM inbox cursor model).
      try {
        const cadenceNotes = await getCadenceInboxNotes(opts.cadenceAddress, {
          flowAccessNode: opts.flowAccessNode ?? FLOW_CADENCE_ACCESS,
          inboxContractAddress: opts.cadenceInboxContractAddress ?? CADENCE_DEPLOYER_ADDRESS,
        });

        for (let i = 0; i < cadenceNotes.length; i++) {
          const note = cadenceNotes[i];
          try {
            const content = await decryptNote(
              note.ciphertext,
              { x: note.ephPubkeyX, y: note.ephPubkeyY },
              opts.memoPrivkey,
            );
            pending += content.amount;
            pendingNotes.push({
              amount: content.amount,
              blinding: content.blinding,
              memo: content.memo,
              inboxIndex: note.index,
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            decryptErrors.push(
              `cadence-inbox[${note.index}]:decrypt_failed:${msg.slice(0, 80)}`,
            );
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `getPortfolioView: Cadence inbox read failed for ${opts.cadenceAddress}: ${msg.slice(0, 120)}`,
        );
        decryptErrors.push(`cadence-inbox:read_error:${msg.slice(0, 100)}`);
      }
    }
    // If isCadenceFt && !opts.cadenceAddress, skip Cadence inbox — cadenceAddress is required.

    const pendingCount = pendingNotes.length;

    // ── 2c. Checkpoint health + safeOpsAvailable ──────────────────────────
    // "coherent"  — Pedersen(shielded+pending, cpBlinding+sumPendingBlinds) == on-chain
    // "stale"     — pendingCount>0 and no deeper corruption detected
    // "corrupted" — pendingCount==0 and commitment still mismatches (blinding bug)
    // "unknown"   — cadence-ft OR RPC error during check
    let checkpointHealth: TokenPortfolioView["checkpointHealth"] = "unknown";
    let safeOpsAvailable: TokenPortfolioView["safeOpsAvailable"] = {
      wrap: true, send: true, claim: true, unwrap: true,
    };

    if (!isCadenceFt && token.janusTokenAddr) {
      try {
        const totalBalance  = shielded + pending;
        const totalBlinding = (cpBlinding + sumPendingBlinds) % BABYJUB_SUBORDER;
        const computed      = await computeCommitment(totalBalance, totalBlinding);

        const cmCalldata = JANUS_ABI.encodeFunctionData("commitments", [coa]);
        const cmRaw      = await provider.call({ to: token.janusTokenAddr, data: cmCalldata });
        const [cx, cy]   = JANUS_ABI.decodeFunctionResult("commitments", cmRaw);
        const onChain    = { x: BigInt(cx), y: BigInt(cy) };

        // Treat both (0,0) [uninitialized storage] and (0,1) [explicit identity] as fresh.
        // JanusToken._effectiveCommitment converts (0,0)→(0,1) internally; the public
        // commitments() getter returns storage raw, which is (0,0) for never-written slots.
        const isIdentity = onChain.x === 0n && (onChain.y === 0n || onChain.y === 1n);

        if (isIdentity && totalBalance === 0n) {
          // Fresh uninitialized slot — coherent by definition.
          checkpointHealth = "coherent";
        } else if (computed.x === onChain.x && computed.y === onChain.y) {
          checkpointHealth = pendingCount > 0 ? "stale" : "coherent";
        } else if (pendingCount > 0) {
          // Mismatch but there are pending notes — likely just stale cursor.
          // send/unwrap absorb pending automatically (cursor fix), claim fixes it too.
          checkpointHealth = "stale";
        } else {
          // pendingCount == 0 and still mismatched — blinding corruption.
          checkpointHealth = "corrupted";
          safeOpsAvailable = { wrap: true, send: false, claim: false, unwrap: false };
        }
      } catch {
        // RPC failure — fall through to heuristic below
        checkpointHealth = "unknown";
      }
    }

    // Heuristic fallback when janusTokenAddr not provided or cadence-ft:
    if (checkpointHealth === "unknown" && !isCadenceFt) {
      // Can't verify against on-chain commitment without janusTokenAddr.
      // Best-effort: if there are pending notes, we know it's at least "stale".
      // If no pending notes, it *may* be coherent or corrupted — we can't tell.
      if (pendingCount > 0) {
        checkpointHealth = "stale";
      } else if (checkpointVersion === 0n || (shielded === 0n && decryptErrors.length === 0)) {
        // No checkpoint and no pending notes — coherent (nothing to corrupt).
        checkpointHealth = "coherent";
      }
      // else: remains "unknown"
    }

    // Cadence-ft heuristic: commitment is Cadence-based (can't Pedersen-check via EVM).
    // Best effort: pending notes mean checkpoint is at minimum stale.
    if (isCadenceFt) {
      checkpointHealth = pendingCount > 0 ? "stale" : "coherent";
    }

    // not_initialized override: ShieldedCheckpoint.read() reverted with NoCheckpoint.
    // The slot has never been written — this is NOT corruption, it's a fresh wallet
    // that needs to run Step 3 (initializeShieldedSlots) or do a first wrap.
    // wrap: safe (wrapFlowAtomic/wrapErc20Atomic auto-initializes via update())
    // send/unwrap: unsafe (no old balance/blinding state to use in ZK proof)
    // claim: safe (starts from zero state; update() creates the slot atomically)
    if (isNoCheckpointSlot && !isCadenceFt) {
      checkpointHealth = "not_initialized";
      safeOpsAvailable = { wrap: true, send: false, claim: true, unwrap: false };
    }

    // Determine source-of-truth for this token:
    // Cadence FT tokens (e.g. MockFT) store commitments in Cadence — everything else is EVM.
    // isCadenceFt is already computed above (before inbox read).
    const sourceOfTruth: TokenPortfolioView["sourceOfTruth"] = isCadenceFt
      ? "cadence-commitments"
      : "evm-checkpoint";

    // freshSlot: no checkpoint has ever been written for this (owner, token) pair.
    // checkpointVersion=0 means the slot is uninitialized or was admin-reset.
    // In either case, callers must reset prevBalance/prevBlinding/prevCursor to zero.
    const freshSlot = checkpointVersion === 0n;

    tokenViews[token.id] = {
      tokenId: token.id,
      tokenAddress: token.address,
      shielded,
      pending,
      total: shielded + pending,
      pendingNotes,
      pendingCount,
      batchEligible: pendingCount >= 10,
      decryptErrors,
      checkpointVersion,
      claimedCursor: lastConsumedNoteIndex,
      sourceOfTruth,
      freshSlot,
      checkpointHealth,
      safeOpsAvailable,
    };
  }

  return {
    coa: checksummedCoa,
    cadenceAddress: opts.cadenceAddress ?? "",
    evmCoaAddress: checksummedCoa,
    tokens: tokenViews,
  };
}
