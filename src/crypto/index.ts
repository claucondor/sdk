/**
 * crypto/index.ts — Higher-level crypto operations (v0.3)
 *
 * These are the operations most app-level code will use.
 * They compose primitives into complete workflows.
 *
 * v0.3 replaces the v0.2 ElGamal proof builders (buildEncryptProof /
 * buildDecryptProof / buildTransferProof) with two generic helpers that
 * directly target the v0.3 Pedersen-commit shape:
 *
 *   buildAmountDiscloseProof   — wrap / unwrap boundary proof
 *   buildShieldedTransferProof — fully shielded sender→recipient transfer
 *
 * The Pedersen commitment helpers and the FLOW unit + babyjub randomness
 * utilities are retained.
 */

// Commitment utilities (Pedersen on BabyJubJub)
export {
  computeCommitment,
  addCommitments,
  negateCommitment,
  identityCommitment,
  isIdentityCommitment,
  generateBlinding,
  decryptBalance,
} from "./commitment";
export type { CommitmentXY } from "./commitment";

// v0.3 amount-disclose proof (wrap + unwrap boundary)
export { buildAmountDiscloseProof } from "./amount-disclose";
export type {
  AmountDiscloseProofInput,
  AmountDiscloseProofResult,
  ProofArtifactOptions,
} from "./amount-disclose";

// v0.3 shielded-transfer proof (HIDDEN amount)
export { buildShieldedTransferProof } from "./shielded-transfer";
export type {
  ShieldedTransferProofInput,
  ShieldedTransferProofResult,
} from "./shielded-transfer";

// BabyJub randomness + FLOW unit conversion helpers
export {
  randomBabyJubScalar,
  flowToWei,
  weiToFlow,
  assertWholeFlow,
  FLOW_DECIMALS,
  FLOW_SCALE,
} from "./babyjub-utils";
