/**
 * inbox/ShieldedInboxClient.ts — EVM client for ShieldedInbox.sol (v0.8).
 *
 * ShieldedInbox is the canonical on-chain mailbox for receiving shielded notes.
 * During shieldedTransfer, the Janus token contract calls inbox.deposit() internally —
 * the recipient does not need to do anything to receive notes.
 *
 * Workflow for state recovery:
 *   1. Restore balance from ShieldedCheckpoint.read() (trusted sender checkpoint).
 *   2. Call inbox.drainAndDecrypt() to process any pending incoming transfers.
 *   3. Sum drained amounts into the checkpoint balance for the current total.
 *
 * Design notes:
 *   - drainAll() and drainBatch() are state-mutating on-chain calls that also return
 *     the drained notes. The client uses staticCall to capture the return value first,
 *     then submits the live tx to actually consume the notes on-chain.
 *   - peek() is a pure view call — safe to call frequently without gas cost.
 *   - Multi-token: notes from different Janus tokens are all deposited to the same inbox.
 *     Use the `depositor` field on each note to identify which token contract sent it.
 *
 * The inbox is deployed at SHIELDED_INBOX_ADDRESS (immutable, no upgrades).
 */

import { ethers } from "ethers";
import { SHIELDED_INBOX_ADDRESS, FLOW_EVM_RPC } from "../network/contracts";
import type { InboxNote } from "../types";
import { decryptNote } from "../crypto/note-helpers";
import type { NoteContent } from "../types";

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

const SHIELDED_INBOX_ABI = [
  // ── view ───────────────────────────────────────────────────────────────
  "function count(address user) external view returns (uint256)",
  "function peek(address user, uint256 offset, uint256 limit) external view returns (tuple(bytes ciphertext, uint256 ephPubkeyX, uint256 ephPubkeyY, address depositor, uint64 blockNumber)[] memory notes)",
  // ── write ──────────────────────────────────────────────────────────────
  "function deposit(address recipient, bytes calldata ciphertext, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  "function drainBatch(uint256 limit) external returns (tuple(bytes ciphertext, uint256 ephPubkeyX, uint256 ephPubkeyY, address depositor, uint64 blockNumber)[] memory notes)",
  "function drainAll() external returns (tuple(bytes ciphertext, uint256 ephPubkeyX, uint256 ephPubkeyY, address depositor, uint64 blockNumber)[] memory notes)",
  // ── events ─────────────────────────────────────────────────────────────
  "event NoteDeposited(address indexed recipient, address indexed depositor, uint256 index)",
  "event NotesDrained(address indexed owner, uint256 count)",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckpointMetadata {
  lastConsumedNoteIndex: bigint;
  lastUpdatedBlock: bigint;
  version: bigint;
  hasCheckpoint: boolean;
}

export interface DrainResult {
  /** Notes drained from the inbox (in FIFO order). */
  notes: InboxNote[];
  /** Transaction hash of the drain call. */
  txHash: string;
}

export interface DrainAndDecryptResult {
  /** Raw notes (always returned regardless of decryption success). */
  notes: InboxNote[];
  /** Successfully decrypted notes, in FIFO order. */
  decrypted: Array<{ note: InboxNote; content: NoteContent }>;
  /** Notes that failed to decrypt (wrong key, or from a different token). */
  failed: InboxNote[];
  /** Transaction hash of the drain call. */
  txHash: string;
}

// ---------------------------------------------------------------------------
// Internal helper: convert raw ABI tuple to InboxNote
// ---------------------------------------------------------------------------

function tupleToInboxNote(raw: {
  ciphertext: string;
  ephPubkeyX: bigint;
  ephPubkeyY: bigint;
  depositor: string;
  blockNumber: bigint;
}): InboxNote {
  return {
    ciphertext: ethers.getBytes(raw.ciphertext),
    ephPubkeyX: raw.ephPubkeyX,
    ephPubkeyY: raw.ephPubkeyY,
    depositor: raw.depositor,
    blockNumber: raw.blockNumber,
  };
}

// ---------------------------------------------------------------------------
// ShieldedInboxClient
// ---------------------------------------------------------------------------

export class ShieldedInboxClient {
  readonly address: string;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly _contract: ethers.Contract;

  constructor(address = SHIELDED_INBOX_ADDRESS, rpcUrl = FLOW_EVM_RPC) {
    this.address = address;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this._contract = new ethers.Contract(address, SHIELDED_INBOX_ABI, this.provider);
  }

  // ── View ────────────────────────────────────────────────────────────────

  /**
   * Number of unread notes pending for `user`.
   * Cheap view call — safe to poll.
   */
  async count(user: string): Promise<bigint> {
    return this._contract.count(user) as Promise<bigint>;
  }

  /**
   * Non-consuming read of notes starting at head+offset, returning up to `limit` notes.
   *
   * @param user    Inbox owner address.
   * @param offset  Offset from the current head (0 = oldest unread).
   * @param limit   Maximum number of notes to return.
   */
  async peek(user: string, offset: bigint, limit: bigint): Promise<InboxNote[]> {
    const raw = await this._contract.peek(user, offset, limit);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (raw as any[]).map(tupleToInboxNote);
  }

  /**
   * Read ALL pending notes for `user` without consuming them.
   * Calls count() then peek(0, count).
   */
  async peekAll(user: string): Promise<InboxNote[]> {
    const n = await this.count(user);
    if (n === 0n) return [];
    return this.peek(user, 0n, n);
  }

  // ── Mutating ─────────────────────────────────────────────────────────────

  /**
   * Drain all pending notes from the caller's inbox.
   *
   * Uses staticCall first to capture the return value, then submits the live tx.
   * Both calls use msg.sender = signer.address, so the drained set is consistent
   * as long as no concurrent drain is running (single-user assumption).
   *
   * @param signer  Ethers wallet (inbox owner).
   */
  async drainAll(signer: ethers.Wallet): Promise<DrainResult> {
    const connected = this._contract.connect(signer) as ethers.Contract;

    // 1. Simulate to capture return values (no state change)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawNotes: any[] = await connected.drainAll.staticCall();
    const notes = rawNotes.map(tupleToInboxNote);

    if (notes.length === 0) {
      // Nothing to drain — skip the on-chain tx to save gas
      return { notes: [], txHash: "" };
    }

    // 2. Submit the live tx
    const tx = await connected.drainAll() as ethers.TransactionResponse;
    await tx.wait();

    return { notes, txHash: tx.hash };
  }

  /**
   * Drain up to `limit` oldest pending notes from the caller's inbox.
   *
   * @param limit   Maximum number of notes to drain.
   * @param signer  Ethers wallet (inbox owner).
   */
  async drainBatch(limit: bigint, signer: ethers.Wallet): Promise<DrainResult> {
    const connected = this._contract.connect(signer) as ethers.Contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawNotes: any[] = await connected.drainBatch.staticCall(limit);
    const notes = rawNotes.map(tupleToInboxNote);

    if (notes.length === 0) {
      return { notes: [], txHash: "" };
    }

    const tx = await connected.drainBatch(limit) as ethers.TransactionResponse;
    await tx.wait();

    return { notes, txHash: tx.hash };
  }

  /**
   * Drain all pending notes AND attempt to decrypt each one.
   *
   * Notes that fail decryption (wrong key, sent by a different token, corrupted)
   * are placed in the `failed` array rather than thrown.
   *
   * @param signer        Ethers wallet (inbox owner).
   * @param memoPrivKey   BabyJub memo private key for ECIES decryption.
   */
  async drainAndDecrypt(
    signer: ethers.Wallet,
    memoPrivKey: bigint,
  ): Promise<DrainAndDecryptResult> {
    const { notes, txHash } = await this.drainAll(signer);

    const decrypted: DrainAndDecryptResult["decrypted"] = [];
    const failed: InboxNote[] = [];

    for (const note of notes) {
      try {
        const content = await decryptNote(
          note.ciphertext,
          { x: note.ephPubkeyX, y: note.ephPubkeyY },
          memoPrivKey,
        );
        decrypted.push({ note, content });
      } catch {
        failed.push(note);
      }
    }

    return { notes, decrypted, failed, txHash };
  }

  /**
   * Deposit a note to `recipient`'s inbox.
   * Called internally by the Janus token contracts on shieldedTransfer —
   * SDK users rarely need to call this directly.
   *
   * @param recipient   Destination address.
   * @param ciphertext  Encrypted note payload.
   * @param ephPubkeyX  ECIES ephemeral pubkey X.
   * @param ephPubkeyY  ECIES ephemeral pubkey Y.
   * @param signer      Ethers wallet (the depositor).
   */
  async deposit(
    recipient: string,
    ciphertext: Uint8Array,
    ephPubkeyX: bigint,
    ephPubkeyY: bigint,
    signer: ethers.Wallet,
  ): Promise<string> {
    const connected = this._contract.connect(signer) as ethers.Contract;
    const tx = await connected.deposit(
      recipient,
      ciphertext,
      ephPubkeyX,
      ephPubkeyY,
    ) as ethers.TransactionResponse;
    await tx.wait();
    return tx.hash;
  }
}
