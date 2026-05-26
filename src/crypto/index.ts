/**
 * crypto/index.ts — Higher-level crypto operations
 *
 * These are the operations most app-level code will use.
 * They compose primitives into complete workflows.
 */

// Commitment utilities
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

// Transfer proof generation
export { buildTransferProof } from "./transfer-proof";
export type { TransferProofInput, TransferProofResult } from "./transfer-proof";

// ElGamal proof builders (Phase C addition for v0.2.0)
// Groth16 proof generation for encrypt_consistency + decrypt_open circuits
// Uses ceremony-backed zkeys (Hermez phase 1 + Flow VRF beacon block 323555648)
export { buildEncryptProof, buildDecryptProof } from "./elgamal-proofs";
export type {
  ElGamalCiphertext,
  EncryptProofInput,
  EncryptProofResult,
  DecryptProofInput,
  DecryptProofResult,
  ProofArtifactOptions,
} from "./elgamal-proofs";
