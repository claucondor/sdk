/**
 * adapters/JanusTokenAdapter.ts — The single adapter interface all tokens implement.
 *
 * Every concrete token (JanusFlow, JanusWFLOW, JanusMockUSDC, JanusMockFT) must
 * satisfy this interface. The frontend only ever calls methods on this interface —
 * it never touches proof generation, fee math, or snapshot ordering directly.
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
  DepositRecord,
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

  /**
   * Block number of the first snapshot event for this address.
   * Returns 0n if the address has never interacted with this contract.
   * Used by scanDeposits to avoid scanning from genesis.
   */
  getFirstSnapshotBlock(addr: string): Promise<bigint>;

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
   * Register the caller's BabyJub pubkey on-chain.
   * v0.6.3: EVM adapters route this to the shared MemoKeyRegistry (one tx
   * covers all Janus EVM tokens simultaneously). Call once; rotate later.
   */
  publishMemoKey(memoKeypair: BabyJubKeypair, signer: EVMSigner): Promise<TxResult>;

  /**
   * Rotate to a new BabyJub pubkey. Must have published first.
   * v0.6.3: EVM adapters route this to the shared MemoKeyRegistry.
   * Optional — not all adapters support rotation (Cadence FT adapter omits it).
   */
  rotateMemoKey?(memoKeypair: BabyJubKeypair, signer: EVMSigner): Promise<TxResult>;

  /**
   * Wrap grossAmount into the caller's shielded slot.
   * SDK internally: reads feeBps → computes net → builds proof → encrypts snapshot → submits tx.
   */
  wrap(params: WrapParams, signer: EVMSigner): Promise<WrapResult>;

  /**
   * Shielded transfer to recipient.
   * SDK internally: reads recipient memoKey → builds TWO ephemerals → 2 proofs → tx.
   */
  shieldedTransfer(params: SendParams, signer: EVMSigner): Promise<SendResult>;

  /**
   * Unwrap claimedAmount back to recipient's wallet.
   * SDK internally: builds amount-disclose proof + transfer proof → encrypts residual snapshot → tx.
   */
  unwrap(params: UnwrapParams, signer: EVMSigner): Promise<UnwrapResult>;

  // ── Scan & decrypt ────────────────────────────────────────────────────────

  /**
   * Scan on-chain events for deposits addressed to addr.
   * Returns raw encrypted deposit records sorted by timestamp ascending.
   * Pass fromBlock to override the firstSnapshotBlock hint.
   */
  scanDeposits(addr: string, fromBlock?: bigint): Promise<DepositRecord[]>;

  /**
   * Decrypt a note (sender→recipient ciphertext from shieldedTransfer).
   * Returns NoteContent with amount, blinding, and optional memo.
   */
  decryptNoteTo(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<NoteContent>;

  /**
   * Decrypt a snapshot (self-directed ciphertext from wrap/shieldedTransfer/unwrap).
   * Returns SnapshotContent with balance, blinding, and timestampMs.
   */
  decryptSnapshot(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<SnapshotContent>;

  /**
   * Reconstruct current shielded state from on-chain events.
   * Scans all snapshot events, decrypts them, orders by timestampMs desc,
   * and returns the most recent valid SnapshotContent.
   */
  latestSnapshot(addr: string, myMemoPrivKey: bigint): Promise<SnapshotContent>;
}
