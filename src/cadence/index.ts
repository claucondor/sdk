/**
 * cadence/ — Cadence transaction templates for ShieldedInbox + ShieldedCheckpoint (v0.8).
 *
 * All templates return Cadence transaction strings ready for use with fcl.mutate().
 * Addresses default to the v0.8 testnet deployment constants.
 *
 * @example
 *   import { cadenceTx } from '@claucondor/sdk/cadence';
 *   // First-time setup (one tx for both inbox + checkpoint):
 *   await fcl.mutate({ cadence: cadenceTx.installInboxAndCheckpoint(), args: () => [] });
 *
 *   // After a JanusFlow shieldedTransfer (EVM), update the checkpoint atomically:
 *   const JANUS_FLOW_PROXY = "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3";
 *   await fcl.mutate({
 *     cadence: cadenceTx.combinedShieldedTransferWithCheckpoint(JANUS_FLOW_PROXY),
 *     args: (arg, t) => [
 *       arg(recipientEVMAddress, t.Address),    // EVM.EVMAddress
 *       arg(publicInputs.map(String), t.Array(t.UInt256)),
 *       arg(proof.map(String), t.Array(t.UInt256)),
 *       arg(Array.from(encryptedNoteTo).map(String), t.Array(t.UInt8)),
 *       arg(ephPubkeyToX.toString(), t.UInt256),
 *       arg(ephPubkeyToY.toString(), t.UInt256),
 *       arg(Array.from(encryptedSnapshot).map(String), t.Array(t.UInt8)),
 *       arg(ephPubkeyX.toString(), t.UInt256),
 *       arg(ephPubkeyY.toString(), t.UInt256),
 *       arg(String(lastConsumedNoteIndex), t.UInt64),
 *     ],
 *   });
 */

import {
  installInbox,
  installCheckpoint,
  installInboxAndCheckpoint,
  updateCheckpointViaCoa,
  combinedShieldedTransferWithCheckpoint,
} from "./transactions";

// Named exports for destructured imports
export {
  installInbox,
  installCheckpoint,
  installInboxAndCheckpoint,
  updateCheckpointViaCoa,
  combinedShieldedTransferWithCheckpoint,
};

/**
 * Namespace bundle — access all templates via `cadenceTx.templateName()`.
 */
export const cadenceTx = {
  installInbox,
  installCheckpoint,
  installInboxAndCheckpoint,
  updateCheckpointViaCoa,
  combinedShieldedTransferWithCheckpoint,
} as const;
