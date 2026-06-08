/**
 * cadence-tx/ — Cadence transaction & script string builders.
 *
 * These helpers produce ready-to-submit Cadence transaction/script strings
 * with FCL-compatible argument arrays. They do NOT submit transactions —
 * use with `flow transactions send --args-json` (CLI) or FCL's `fcl.mutate`.
 */

export {
  buildRecordTipWithSnapshotEvmTx,
  buildShieldedTransferPlusRecordTipEvmTx,
  buildShieldedTransferFTPlusRecordTipEvmTx,
  buildGetShieldedTipsBySenderWithSnapshotEvmScript,
} from "./private-tip-evm";

export type {
  FclArg,
  BuildRecordTipEvmTxArgs,
  RecordTipEvmTxResult,
  BuildShieldedTransferPlusRecordTipEvmTxArgs,
  ShieldedTransferPlusRecordTipEvmTxResult,
  BuildShieldedTransferFTPlusRecordTipEvmTxArgs,
} from "./private-tip-evm";
