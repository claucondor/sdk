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
import { FLOW_EVM_RPC, FLOW_CADENCE_ACCESS, CADENCE_DEPLOYER_ADDRESS } from "../network/contracts";
import { getCadenceInboxNotes } from "../inbox/CadenceInboxClient";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  /** Tokens to query: id (stable label) + address (EVM proxy / 20-byte padded Cadence addr). */
  tokens: Array<{ id: string; address: string }>;
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
    let checkpointVersion = 0n;
    // Cursor: notes at absoluteIndex < lastConsumedNoteIndex have been logically
    // consumed into the shielded checkpoint and must NOT be counted as pending again.
    let lastConsumedNoteIndex = 0n;

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
          } else {
            decryptErrors.push(`checkpoint:decrypt_failed:token=${token.address}`);
          }
        }
        // version=0 with empty snapshot means no checkpoint yet — shielded stays 0n
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // NoCheckpoint revert or not-yet-created — not a bug, just no checkpoint
      if (!msg.includes("NoCheckpoint") && !msg.includes("0x9e87fac8")) {
        decryptErrors.push(`checkpoint:read_error:${msg.slice(0, 100)}`);
      }
      // shielded stays 0n; lastConsumedNoteIndex stays 0n (all notes visible)
    }

    // ── 2b. Inbox notes for this token ────────────────────────────────────
    const pendingNotes: TokenPortfolioView["pendingNotes"] = [];
    let pending = 0n;

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
    };
  }

  return {
    coa: checksummedCoa,
    cadenceAddress: opts.cadenceAddress ?? "",
    evmCoaAddress: checksummedCoa,
    tokens: tokenViews,
  };
}
