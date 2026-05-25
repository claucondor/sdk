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
 *   tokens-v2/  — v2 token abstractions (JanusTokenV2, JanusFlowV2 — ElGamal-on-BabyJub)
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
// Token operations — v2 (ElGamal-on-BabyJub) — RECOMMENDED for new apps
// Provides multi-sender privacy: recipients learn only the total, not per-sender amounts
// ---------------------------------------------------------------------------
export {
  JanusTokenV2,
  JanusFlowV2,
  JANUS_TOKEN_V2_TESTNET,
  JANUS_FLOW_V2_CADENCE_ADDRESS,
  JANUS_FLOW_V2_VERSION,
  JANUS_V2_BABYJUB_ADDRESS,
  ENCRYPT_CONSISTENCY_VERIFIER,
  DECRYPT_OPEN_VERIFIER,
} from "./tokens-v2";

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
export * as elgamal from "./primitives/babyjub"; // re-exported as elgamal for v2 users

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
