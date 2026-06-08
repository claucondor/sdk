/**
 * types.ts — Shared types for @claucondor/sdk v0.6.0
 *
 * Single file for all cross-module type exports. Each major section is
 * self-explanatory. Keep this file free of runtime code — types only.
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
// Snapshot schema (self-directed encrypted state blob)
// ---------------------------------------------------------------------------

/**
 * SNAPSHOT_TIMESTAMP_UNIT is always 'ms' (milliseconds since epoch).
 * This constant is exported so every layer that reads/writes timestamps
 * can import a single authoritative source — the v0.5.6 bug was a unit
 * mismatch between scanner (seconds) and reconstructor (milliseconds).
 */
export const SNAPSHOT_TIMESTAMP_UNIT = "ms" as const;

export interface SnapshotContent {
  /** Hidden balance in native units (attoFLOW / raw ERC20 / UFix64 raw) */
  balance: bigint;
  /** Pedersen blinding factor */
  blinding: bigint;
  /** Unix timestamp in MILLISECONDS when this snapshot was encrypted */
  timestampMs: number;
  // v3 additions — present only on shielded-transfer sender snapshots
  /** Transfer amount sent (undefined on wrap/unwrap snapshots) */
  txAmt?: bigint;
  /** Recipient hint: Cadence address or COA EVM hex (undefined on wrap/unwrap snapshots) */
  rcp?: string;
  /** Plaintext memo attached to the transfer (undefined on wrap/unwrap snapshots) */
  memo?: string;
}

// ---------------------------------------------------------------------------
// Note schema (sender-to-recipient encrypted amount+blinding)
// ---------------------------------------------------------------------------
export interface NoteContent {
  /** Amount transferred */
  amount: bigint;
  /** Per-transfer blinding factor */
  blinding: bigint;
  /** Optional UTF-8 memo / app payload */
  memo?: string;
  /** Optional tip identifier */
  tipId?: string;
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

export interface DepositRecord {
  /** Encrypted note payload */
  ciphertext: Uint8Array;
  /** Ephemeral pubkey used for encryption */
  ephPubkey: { x: bigint; y: bigint };
  /** Unix timestamp in milliseconds */
  timestampMs: number;
  txHash: string;
  blockNumber?: number;
}
