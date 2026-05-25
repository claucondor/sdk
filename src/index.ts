/**
 * @openjanus/sdk
 *
 * Unified SDK for OpenJanus privacy primitives on Flow.
 *
 * Module hierarchy:
 *   types/      — Shared TypeScript types (no runtime code)
 *   utils/      — Pure utilities (hex, pi_b swap)
 *   primitives/ — Low-level crypto (BabyJub, Pedersen, Groth16)
 *   network/    — Flow client + COA management
 *   crypto/     — High-level crypto operations (commitments, proofs)
 *
 * v1 token module (JanusToken/JanusFlow, Pedersen-hash based) was removed in 0.2.0.
 * Historical source: git checkout v0.1.0-final
 * Migration guide: docs/why-v1-was-deprecated.md
 *
 * Adding a new module:
 *   1. Create src/modules/<name>/{types.ts,<name>.ts,index.ts}
 *   2. Re-export from this file under the appropriate namespace
 *   3. See docs/EXTENDING.md for full guidance
 */

// ---------------------------------------------------------------------------
// Crypto operations — for advanced app code and integrators
// ---------------------------------------------------------------------------
export {
  computeCommitment,
  addCommitments,
  negateCommitment,
  identityCommitment,
  isIdentityCommitment,
  generateBlinding,
  decryptBalance,
  buildTransferProof,
} from "./crypto";
export type { TransferProofInput, TransferProofResult } from "./crypto";

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
  CommitmentXY,
} from "./types/commitment";
export { CURVE_P, IDENTITY_POINT, isIdentityPoint } from "./types/commitment";

export type {
  SnarkJSProof,
  EVMProof,
  ProofUint256,
  ConfidentialTransferPublicInputs,
  PublicInputsUint256,
} from "./types/proof";
