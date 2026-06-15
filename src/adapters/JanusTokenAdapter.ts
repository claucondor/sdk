/**
 * adapters/JanusTokenAdapter.ts — The single adapter interface all tokens implement.
 *
 * v0.8 changes:
 *   - shieldedTransfer: removed encryptedSnapshot / ephPubkeyX / ephPubkeyY from calldata.
 *     The new 6-arg signature matches JanusFlow/JanusERC20 v0.8 ABI.
 *   - SendResult: now returns checkpointPayload so callers can compose ShieldedCheckpoint.update().
 *   - getFirstSnapshotBlock / scanDeposits / latestSnapshot: removed (superseded by ShieldedInbox).
 *     Use ShieldedInboxClient.drain() for state recovery instead.
 *   - decryptSnapshot still available for checkpoint decryption path.
 *
 * ALL orchestration (gross→net→proof→encrypt→tx) lives in src/orchestration/.
 * Adapters delegate to orchestration helpers; they do NOT re-implement logic.
 */

import type {
  BabyJubKeypair,
  WrapParams,
  WrapResult,
  SendParams,
  SendResult,
  UnwrapParams,
  UnwrapResult,
  TxResult,
  NoteContent,
  SnapshotContent,
} from "../types";
import type { TokenVariant } from "../types";
import type { Point } from "../types/commitment";

// Minimal signer shape — ethers Wallet for EVM tokens, Flow signer for Cadence
export type EVMSigner = import("ethers").Wallet;

export interface JanusTokenAdapter {
  readonly id: string;
  readonly variant: TokenVariant;
  readonly address: string;
  readonly decimals: number;

  // ── Read (no tx) ──────────────────────────────────────────────────────────

  /** ERC20/native balance of address in wei (NOT the shielded commitment). */
  getBalance(addr: string): Promise<bigint>;

  /** On-chain Pedersen commitment for this address. */
  getCommitment(addr: string): Promise<Point>;

  /** Registered BabyJub memo key, or null if not published. */
  getMemoKey(addr: string): Promise<{ x: bigint; y: bigint } | null>;

  /** Current fee rate in basis points (10 = 0.1%). */
  feeBps(): Promise<number>;

  /** Fee recipient address. */
  feeRecipient(): Promise<string>;

  /**
   * Compute net amount after fee deduction.
   * computeNet(gross) = gross - floor(gross * feeBps / 10000)
   */
  computeNet(gross: bigint): Promise<bigint>;

  // ── Write (tx) ────────────────────────────────────────────────────────────

  /**
   * Register the caller's BabyJub pubkey on-chain (MemoKeyRegistry).
   * One tx covers all Janus EVM tokens simultaneously.
   * Call once; rotate via rotateMemoKey if key is compromised.
   */
  publishMemoKey(memoKeypair: BabyJubKeypair, signer: EVMSigner): Promise<TxResult>;

  /**
   * Rotate to a new BabyJub pubkey. Must have published first.
   * Optional — not all adapters support rotation.
   */
  rotateMemoKey?(memoKeypair: BabyJubKeypair, signer: EVMSigner): Promise<TxResult>;

  /**
   * Wrap grossAmount into the caller's shielded slot.
   * SDK internally: reads feeBps → computes net → builds proof → encrypts snapshot → submits tx.
   */
  wrap(params: WrapParams, signer: EVMSigner): Promise<WrapResult>;

  /**
   * Shielded transfer to recipient.
   * v0.8: 6-arg calldata (no sender snapshot in tx). Returns checkpointPayload
   * so callers can call ShieldedCheckpoint.update() after the transfer.
   */
  shieldedTransfer(params: SendParams, signer: EVMSigner): Promise<SendResult>;

  /**
   * Unwrap claimedAmount back to recipient's wallet.
   * SDK internally: builds amount-disclose proof + transfer proof → encrypts residual snapshot → tx.
   */
  unwrap(params: UnwrapParams, signer: EVMSigner): Promise<UnwrapResult>;

  // ── Decrypt ───────────────────────────────────────────────────────────────

  /**
   * Decrypt a note (sender→recipient ciphertext from shieldedTransfer).
   * Returns NoteContent with amount, blinding, and optional memo.
   */
  decryptNoteTo(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<NoteContent>;

  /**
   * Decrypt a checkpoint snapshot (self-directed ciphertext from wrap/unwrap or
   * ShieldedCheckpoint.read()). Returns SnapshotContent with balance and blinding.
   */
  decryptSnapshot(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<SnapshotContent>;
}
