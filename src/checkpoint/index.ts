/**
 * checkpoint/ — ShieldedCheckpointClient for EVM ShieldedCheckpoint contract (v0.8).
 *
 * The ShieldedCheckpoint replaces event-scanning as the canonical source of truth
 * for a user's own shielded balance. Persists the sender's latest balance+blinding
 * encrypted to their own memo key.
 *
 * @example
 *   import { ShieldedCheckpointClient } from '@claucondor/sdk/checkpoint';
 *   const cp = new ShieldedCheckpointClient();
 *
 *   // After shieldedTransfer:
 *   const { checkpointPayload } = await adapter.shieldedTransfer(params, signer);
 *   await cp.update(checkpointPayload, inboxNotesCursor, signer);
 *
 *   // On session recovery:
 *   const snapshot = await cp.readAndDecrypt(signer, memoPrivKey);
 *   console.log('balance:', snapshot?.balance);
 */

export { ShieldedCheckpointClient } from "./ShieldedCheckpointClient";
export type { CheckpointMetadata, RawCheckpoint, UpdateResult } from "./ShieldedCheckpointClient";
