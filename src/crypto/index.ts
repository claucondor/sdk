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
