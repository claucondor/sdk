/**
 * safety/index.ts — Barrel for SDK safety guards.
 *
 * These helpers run pre-flight sanity checks before submitting transactions.
 * Use them to gate UI operations and surface clear errors before wasting gas.
 */

export { assertCheckpointMatchesCommit, CheckpointDivergenceError } from "./assertCheckpointMatchesCommit";
export type { AssertCheckpointOpts } from "./assertCheckpointMatchesCommit";

export { isOpSafeNow } from "./isOpSafeNow";
export type { OpType, SuggestedAction, OpSafetyResult } from "./isOpSafeNow";

export {
  safeBuildWrapProof,
  safeBuildSendProof,
  safeBuildClaimProof,
  safeBuildUnwrapProof,
} from "./safeBuildProofs";
export type { SafeProofOpts } from "./safeBuildProofs";
