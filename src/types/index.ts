/**
 * types/index.ts — Public type re-exports
 *
 * All cross-module shared TypeScript types. Import types from here
 * to avoid circular dependencies between modules.
 */

export type {
  SnarkJSProof,
  EVMProof,
  ProofUint256,
  ConfidentialTransferPublicInputs,
  PublicInputsUint256,
} from "./proof";

export type { Point, CommitmentXY } from "./commitment";
export { CURVE_P, IDENTITY_POINT, isIdentityPoint } from "./commitment";
