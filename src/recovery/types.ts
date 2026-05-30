/**
 * recovery/types.ts — Shared types for the @openjanus/sdk recovery module.
 *
 * The recovery module reconstructs a user's shielded state from on-chain
 * encrypted snapshot events. Snapshots are emitted by JanusFlow.sol v0.5.2
 * on every state-changing operation (wrap, shieldedTransfer, unwrap).
 */

export interface Snapshot {
  balance: bigint;
  blinding: bigint;
  timestamp: number;
  txHash?: string;
}

export interface IncomingDelta {
  amount: bigint;
  blinding: bigint;
  timestamp: number;
}

export interface RecoveredShieldedState {
  balanceWei: bigint;
  blinding: bigint;
}

export class RecoveryDesyncError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RecoveryDesyncError";
  }
}
