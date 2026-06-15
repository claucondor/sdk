/**
 * types.ts — Shared types for @claucondor/sdk v0.8
 *
 * Single file for all cross-module type exports.
 * Keep this file free of runtime code — types only.
 *
 * v0.8 changes from v0.7:
 *   - NoteContent: removed tipId (app-specific, not protocol)
 *   - DepositRecord: added depositor field (from ShieldedInbox.Note)
 *   - SnapshotContent: stripped to minimal {balance, blinding} — checkpoint
 *     is opaque bytes per ShieldedCheckpoint design; v3 scan-era fields dropped
 *   - SendResult: added checkpointPayload for caller to compose ShieldedCheckpoint.update()
 */

// ---------------------------------------------------------------------------
// Primitives re-exported for convenience
// ---------------------------------------------------------------------------
export type { Point, CommitmentXY } from "./types/commitment";

// ---------------------------------------------------------------------------
// BabyJub keypair (used for memo-key derivation + ECIES)
// ---------------------------------------------------------------------------
export interface BabyJubKeypair {
  privkey: bigint;
  pubkey: { x: bigint; y: bigint };
}

// ---------------------------------------------------------------------------
// Token registry entry shapes
// ---------------------------------------------------------------------------
export type TokenVariant = "native" | "erc20" | "cadence-ft";

export interface NativeTokenEntry {
  variant: "native";
  proxy: string;
  decimals: number;
}

export interface ERC20TokenEntry {
  variant: "erc20";
  proxy: string;
  underlying: string;
  decimals: number;
}

export interface CadenceFTTokenEntry {
  variant: "cadence-ft";
  cadenceAddress: string;
  contractName: string;
  ftAddress: string;
  ftContractName: string;
  decimals: number;
}

export type TokenRegistryEntry = NativeTokenEntry | ERC20TokenEntry | CadenceFTTokenEntry;

// ---------------------------------------------------------------------------
// Snapshot schema — minimal v0.8 checkpoint payload
// ---------------------------------------------------------------------------

/**
 * Minimal checkpoint content for ShieldedCheckpoint.update().
 * The checkpoint stores opaque bytes — this is the SDK-canonical schema.
 * Apps that need additional metadata should encrypt it separately or
 * extend the wire format in their own application layer.
 */
export interface SnapshotContent {
  /** Hidden balance in native units (attoFLOW / raw ERC20 / UFix64 raw) */
  balance: bigint;
  /** Pedersen blinding factor */
  blinding: bigint;
}

// ---------------------------------------------------------------------------
// Note schema (sender-to-recipient encrypted amount+blinding)
// ---------------------------------------------------------------------------

/**
 * Protocol-canonical note content — schema-agnostic ECIES payload.
 * tipId and other app-specific fields are NOT part of the protocol.
 * Apps building on top (e.g. PrivateTip) should encrypt their own payload
 * using encryptText() and extend their schema locally.
 */
export interface NoteContent {
  /** Amount transferred in native units */
  amount: bigint;
  /** Per-transfer Pedersen blinding factor */
  blinding: bigint;
  /** Optional UTF-8 memo string */
  memo?: string;
}

// ---------------------------------------------------------------------------
// ShieldedInbox note (from drainBatch / drainAll / peek)
// ---------------------------------------------------------------------------

/**
 * A note from ShieldedInbox.drainBatch / drainAll.
 * The `depositor` field identifies which token contract called deposit(),
 * enabling multi-token disambiguation when decrypting inbox contents.
 */
export interface InboxNote {
  /** ECIES-encrypted note payload (opaque bytes from the chain) */
  ciphertext: Uint8Array;
  /** Ephemeral pubkey X component used for ECIES encryption */
  ephPubkeyX: bigint;
  /** Ephemeral pubkey Y component used for ECIES encryption */
  ephPubkeyY: bigint;
  /**
   * Address of the token contract that called deposit().
   * Compare against TOKEN_REGISTRY entries to determine token type.
   */
  depositor: string;
  /** EVM block number when the note was deposited */
  blockNumber: bigint;
}

// ---------------------------------------------------------------------------
// DepositRecord — raw encrypted deposit (kept for compatibility)
// ---------------------------------------------------------------------------

export interface DepositRecord {
  /** Encrypted note payload */
  ciphertext: Uint8Array;
  /** Ephemeral pubkey used for encryption */
  ephPubkey: { x: bigint; y: bigint };
  /**
   * Address of the token contract that deposited this note.
   * Required for multi-token inbox disambiguation.
   */
  depositor: string;
  /** EVM block number when deposited */
  blockNumber: bigint;
}

// ---------------------------------------------------------------------------
// Checkpoint payload (from shielded transfer, to be passed to ShieldedCheckpoint.update)
// ---------------------------------------------------------------------------

/**
 * Encrypted checkpoint payload returned by orchestrateShieldedTransfer.
 * Pass these three fields to ShieldedCheckpoint.update() — either as a
 * separate EVM transaction or atomically via combined_shielded_transfer_with_checkpoint.cdc.
 */
export interface CheckpointPayload {
  encryptedSnapshot: Uint8Array;
  ephPubkeyX: bigint;
  ephPubkeyY: bigint;
}

// ---------------------------------------------------------------------------
// Adapter method param/result types
// ---------------------------------------------------------------------------

export interface WrapParams {
  /** Gross amount (before fee). SDK computes net internally. */
  grossAmount: bigint;
}

export interface WrapResult {
  txHash: string;
  netAmount: bigint;
  fee: bigint;
}

export interface SendParams {
  /** EVM address (for native/erc20) or Cadence address (for cadence-ft) */
  recipient: string;
  /** Amount to transfer */
  amount: bigint;
  /** Optional memo text */
  memo?: string;
  /** Current balance (needed for proof generation) */
  currentBalance: bigint;
  /** Current blinding factor (needed for proof generation) */
  currentBlinding: bigint;
}

export interface SendResult {
  txHash: string;
  /**
   * Checkpoint payload for the sender. Call ShieldedCheckpoint.update() with these
   * fields after the transfer to persist sender state.
   * May be omitted if the adapter chose not to compute it (rare edge case).
   */
  checkpointPayload?: CheckpointPayload;
  /** New sender balance after transfer (for local state update). */
  newBalance?: bigint;
  /** New sender blinding after transfer (for local state update). */
  newBlinding?: bigint;
}

export interface UnwrapParams {
  /** Claimed amount to withdraw */
  claimedAmount: bigint;
  /** EVM address (native/erc20) or Cadence address (cadence-ft) */
  recipient: string;
  /** Current balance (needed for proof) */
  currentBalance: bigint;
  /** Current blinding factor */
  currentBlinding: bigint;
}

export interface UnwrapResult {
  txHash: string;
  netToRecipient: bigint;
}

export interface TxResult {
  txHash: string;
}

// ---------------------------------------------------------------------------
// Timestamp unit (kept for backward compat with any code that imports it)
// ---------------------------------------------------------------------------

/** @deprecated SnapshotContent no longer carries a timestamp in v0.8 */
export const SNAPSHOT_TIMESTAMP_UNIT = "ms" as const;
