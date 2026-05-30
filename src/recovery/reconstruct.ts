/**
 * recovery/reconstruct.ts — Pure reconstruction algorithm.
 *
 * Given a set of decrypted self-snapshots and any incoming deltas (shielded
 * transfers received from other users), computes the user's current shielded
 * state and validates it against the on-chain Pedersen commitment.
 *
 * Algorithm:
 *   1. Sort snapshots by timestamp.
 *   2. Take the LATEST snapshot as the base (balance, blinding, timestamp).
 *   3. Add any incoming deltas that arrived AFTER the latest snapshot timestamp.
 *   4. Validate (balance, blinding) against the on-chain commitment.
 *   5. Return the validated RecoveredShieldedState, or throw RecoveryDesyncError.
 *
 * Limitations:
 *   - Activity that happened BEFORE snapshot events were enabled on JanusFlow
 *     v0.5.2 cannot be recovered via this algorithm. In that case the
 *     on-chain commitment will never match the reconstructed state and a
 *     RecoveryDesyncError is thrown.
 */

import type { Snapshot, IncomingDelta, RecoveredShieldedState } from "./types";
import { RecoveryDesyncError } from "./types";
import { validatePedersenCommit } from "./validate";

export interface ReconstructFromSnapshotsOptions {
  snapshots: Snapshot[];
  incomingDeltas: IncomingDelta[];
  onChainCommit: { x: bigint; y: bigint };
}

export async function reconstructFromSnapshots(
  opts: ReconstructFromSnapshotsOptions
): Promise<RecoveredShieldedState> {
  const { snapshots, incomingDeltas, onChainCommit } = opts;

  // Sort snapshots by timestamp ascending, pick the latest as base.
  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);

  let base: { balance: bigint; blinding: bigint; timestamp: number };
  if (sorted.length === 0) {
    base = { balance: 0n, blinding: 0n, timestamp: 0 };
  } else {
    const latest = sorted[sorted.length - 1];
    base = {
      balance: latest.balance,
      blinding: latest.blinding,
      timestamp: latest.timestamp,
    };
  }

  // Apply incoming deltas that arrived after the base snapshot.
  for (const delta of incomingDeltas) {
    if (delta.timestamp > base.timestamp) {
      base.balance += delta.amount;
      base.blinding += delta.blinding;
    }
  }

  // Validate the reconstructed state against the on-chain commitment.
  const isValid = await validatePedersenCommit(base.balance, base.blinding, onChainCommit);
  if (!isValid) {
    throw new RecoveryDesyncError(
      `Reconstructed state does not match on-chain commitment. ` +
        `Reconstructed balance=${base.balance}, blinding=${base.blinding}. ` +
        `On-chain commit=(${onChainCommit.x.toString(16).slice(0, 12)}..., ` +
        `${onChainCommit.y.toString(16).slice(0, 12)}...). ` +
        `Likely cause: state has activity from before snapshot events were enabled ` +
        `(JanusFlow v0.5.2 upgrade) or missing incoming deltas.`
    );
  }

  return { balanceWei: base.balance, blinding: base.blinding };
}
