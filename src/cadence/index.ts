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
 *   // Atomic wrap (FLOW): move FLOW + update checkpoint in one tx
 *   const JANUS_FLOW_PROXY = "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3";
 *   await fcl.mutate({
 *     cadence: cadenceTx.wrapFlowAtomic(JANUS_FLOW_PROXY),
 *     args: (arg, t) => [
 *       arg("1.00000000", t.UFix64),
 *       arg("1000000000000000000", t.UInt),
 *       arg(wrapCalldataHex, t.String),
 *       arg(encryptedSnapshotHex, t.String),
 *       arg(ephPubkeyX.toString(), t.UInt256),
 *       arg(ephPubkeyY.toString(), t.UInt256),
 *       arg(String(lastConsumedNoteIndex), t.UInt64),
 *     ],
 *   });
 *
 *   // After a JanusFlow shieldedTransfer (EVM), update the checkpoint atomically:
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

import {
  updateCheckpointViaCoa as atomicUpdateCheckpointViaCoa,
  wrapFlowAtomic,
  sendTipAtomic,
  unwrapFlowAtomic,
  claimBatchAtomic,
  wrapErc20Atomic,
  sendTipErc20Atomic,
  unwrapErc20Atomic,
  wrapFtAtomic,
  sendTipFtAtomic,
  unwrapFtAtomic,
  claimBatchFtAtomic,
} from "./atomic-transactions";

// Named exports for destructured imports
export {
  installInbox,
  installCheckpoint,
  installInboxAndCheckpoint,
  updateCheckpointViaCoa,
  combinedShieldedTransferWithCheckpoint,
  wrapFlowAtomic,
  sendTipAtomic,
  unwrapFlowAtomic,
  claimBatchAtomic,
  wrapErc20Atomic,
  sendTipErc20Atomic,
  unwrapErc20Atomic,
  wrapFtAtomic,
  sendTipFtAtomic,
  unwrapFtAtomic,
  claimBatchFtAtomic,
};

/**
 * Namespace bundle — access all templates via `cadenceTx.templateName()`.
 *
 * Non-atomic templates (install/setup):
 *   cadenceTx.installInbox()
 *   cadenceTx.installCheckpoint()
 *   cadenceTx.installInboxAndCheckpoint()
 *   cadenceTx.updateCheckpointViaCoa()              — standalone checkpoint update
 *   cadenceTx.combinedShieldedTransferWithCheckpoint(janusProxy)
 *
 * Atomic templates (preferred for production — single-tx, no orphaned checkpoint):
 *   cadenceTx.wrapFlowAtomic(tokenAddrHex)                          — wrap + checkpoint (FLOW)
 *   cadenceTx.sendTipAtomic(tokenAddrHex)                           — shieldedTransfer + checkpoint (EVM, any)
 *   cadenceTx.unwrapFlowAtomic(tokenAddrHex)                        — unwrap + checkpoint (FLOW)
 *   cadenceTx.claimBatchAtomic(tokenAddrHex)                        — drainAll + claimBatch + checkpoint (EVM)
 *   cadenceTx.wrapErc20Atomic(tokenAddrHex)                         — approve + wrap + checkpoint (ERC20)
 *   cadenceTx.sendTipErc20Atomic(tokenAddrHex)                      — shieldedTransfer + checkpoint (ERC20)
 *   cadenceTx.unwrapErc20Atomic(tokenAddrHex)                       — unwrap + checkpoint (ERC20)
 *   cadenceTx.wrapFtAtomic(tokenAddrHex, addr, ft, ftAddr)          — JanusFT wrap + checkpoint (cadence-ft)
 *   cadenceTx.sendTipFtAtomic(tokenAddrHex, addr)                   — JanusFT transfer + checkpoint (cadence-ft)
 *   cadenceTx.unwrapFtAtomic(tokenAddrHex, addr, ft, ftAddr)        — JanusFT unwrap + checkpoint (cadence-ft)
 *   cadenceTx.claimBatchFtAtomic(tokenAddrHex, addr)                — JanusFT claimBatch + checkpoint (cadence-ft)
 */
export const cadenceTx = {
  installInbox,
  installCheckpoint,
  installInboxAndCheckpoint,
  updateCheckpointViaCoa,
  combinedShieldedTransferWithCheckpoint,
  // Atomic templates (from atomic-transactions.ts, moved from PrivateTip frontend)
  atomicUpdateCheckpointViaCoa,
  wrapFlowAtomic,
  sendTipAtomic,
  unwrapFlowAtomic,
  claimBatchAtomic,
  // ERC20 atomic templates (v0.8.2 audit additions)
  wrapErc20Atomic,
  sendTipErc20Atomic,
  unwrapErc20Atomic,
  // cadence-ft atomic templates (v0.8.2 audit additions)
  wrapFtAtomic,
  sendTipFtAtomic,
  unwrapFtAtomic,
  claimBatchFtAtomic,
} as const;
