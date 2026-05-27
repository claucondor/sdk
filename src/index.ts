/**
 * @openjanus/sdk — v0.3
 *
 * Generic, app-agnostic SDK for OpenJanus confidential token primitives on Flow.
 *
 * v0.3 highlights:
 *   - JanusFlow (native FLOW confidential token) — fully shielded transfers,
 *     leaks only at the wrap/unwrap boundary by design.
 *   - JanusToken abstract base — ready for ERC-20 / cross-asset extensions.
 *   - Generic crypto helpers — buildAmountDiscloseProof, buildShieldedTransferProof.
 *   - Bundled Groth16 artifacts in circuits/v0.3/ (Hermez pot14 + Flow VRF beacon).
 *
 * Module hierarchy:
 *   types/      — Shared TypeScript types (no runtime code)
 *   utils/      — Pure utilities (hex, pi_b swap)
 *   primitives/ — Low-level crypto (BabyJub, Pedersen, Groth16)
 *   network/    — Flow client + COA management
 *   crypto/     — High-level crypto operations (commitments, proofs)
 *   tokens/     — JanusToken (abstract) + JanusFlow (concrete native FLOW)
 *
 * See MIGRATION-v0.3.md for v0.2 → v0.3 migration notes.
 */

// ---------------------------------------------------------------------------
// Token primitive — generic confidential token (v0.3 Pedersen)
// ---------------------------------------------------------------------------
export {
  JanusToken,
  JanusFlow,
  JanusFlowCadence,
  JANUS_TOKEN_BASE_ABI,
  JANUS_BABYJUB_ADDRESS,
  AMOUNT_DISCLOSE_VERIFIER,
  CONFIDENTIAL_TRANSFER_VERIFIER,
  JANUS_TOKEN_OWNER_EVM,
  JANUS_FLOW_TESTNET,
  JANUS_FLOW_EVM_ADDRESS,
  JANUS_FLOW_EVM_IMPL_ADDRESS,
  JANUS_FLOW_CADENCE_ADDRESS,
  JANUS_FLOW_CONTRACT_NAME,
  JANUS_FLOW_VERSION,
  JANUS_FLOW_MAX_WRAP_ATTOFLOW,
} from "./tokens";
export type {
  JanusTokenOptions,
  JanusFlowCadenceOptions,
  JanusFlowConstructorOptions,
  TokenOptions,
  TokenDeployment,
} from "./tokens";

// ---------------------------------------------------------------------------
// Crypto operations — for advanced app code and integrators
// ---------------------------------------------------------------------------
export {
  // Pedersen commitment helpers
  computeCommitment,
  addCommitments,
  negateCommitment,
  identityCommitment,
  isIdentityCommitment,
  generateBlinding,
  decryptBalance,
  // v0.3 proof builders
  buildAmountDiscloseProof,
  buildShieldedTransferProof,
  // BabyJub randomness + FLOW unit helpers
  randomBabyJubScalar,
  flowToWei,
  weiToFlow,
  assertWholeFlow,
  FLOW_DECIMALS,
  FLOW_SCALE,
} from "./crypto";
export type {
  CommitmentXY,
  AmountDiscloseProofInput,
  AmountDiscloseProofResult,
  ShieldedTransferProofInput,
  ShieldedTransferProofResult,
  ProofArtifactOptions,
} from "./crypto";

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------
export { NETWORK_CONFIG, createEvmProvider, createEvmWallet, configureFCL } from "./network";
export type { FlowNetwork } from "./network";

// ---------------------------------------------------------------------------
// Module namespaces — for power users and extension authors
// ---------------------------------------------------------------------------
export * as primitives from "./primitives";
export * as network from "./network";
export * as utils from "./utils";

// ---------------------------------------------------------------------------
// Shared types — import these for TypeScript type annotations
// ---------------------------------------------------------------------------
export type {
  Point,
  CommitmentXY as CommitmentPoint,
} from "./types/commitment";
export { CURVE_P, IDENTITY_POINT, isIdentityPoint } from "./types/commitment";

export type {
  SnarkJSProof,
  EVMProof,
  ProofUint256,
  PublicInputsUint256,
} from "./types/proof";
