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
 *   tokens/ — JanusToken, JanusFlow (ElGamal-on-BabyJub confidential token stack)
 *
 * Adding a new module:
 *   1. Create src/modules/<name>/{types.ts,<name>.ts,index.ts}
 *   2. Re-export from this file under the appropriate namespace
 *   3. See docs/EXTENDING.md for full guidance
 */

// ---------------------------------------------------------------------------
// Token operations — ElGamal-on-BabyJub confidential token stack
// Multi-sender privacy: recipients learn only the total, not per-sender amounts
// ---------------------------------------------------------------------------
export {
  JanusToken,
  JanusFlow,
  JANUS_TOKEN_TESTNET,
  JANUS_FLOW_CADENCE_ADDRESS,
  JANUS_FLOW_VERSION,
  JANUS_BABYJUB_ADDRESS,
  ENCRYPT_CONSISTENCY_VERIFIER,
  DECRYPT_OPEN_VERIFIER,
} from "./tokens";

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
  // ElGamal proof builders (v0.2.0) — Groth16 provers for encrypt/decrypt circuits
  buildEncryptProof,
  buildDecryptProof,
} from "./crypto";
export type {
  TransferProofInput,
  TransferProofResult,
  // ElGamal proof types (v0.2.0)
  ElGamalCiphertext,
  EncryptProofInput,
  EncryptProofResult,
  DecryptProofInput,
  DecryptProofResult,
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
export * as elgamal from "./primitives/babyjub"; // re-exported as elgamal for token users

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
