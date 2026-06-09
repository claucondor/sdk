/**
 * crypto/index.ts — Higher-level crypto operations (v0.8)
 *
 * These are the operations most app-level code will use.
 * They compose primitives into complete workflows.
 *
 * v0.8 design: schema-agnostic ECIES primitives. The SDK provides a canonical
 * note schema ({v:1, amt, bld, memo?}) but apps are free to encrypt arbitrary
 * payloads using encryptText / decryptText directly.
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

// Aggregate amount-disclose proof (wrap + unwrap boundary)
export { buildAmountDiscloseProof } from "./amount-disclose";
export type {
  AmountDiscloseProofInput,
  AmountDiscloseProofResult,
  ProofArtifactOptions,
} from "./amount-disclose";

// Shielded-transfer proof (hidden amount)
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
  parseFlowToWei,
  formatWeiToFlow,
  weiToFlowUFix64,
  assertWholeFlow,
  FLOW_DECIMALS,
  FLOW_SCALE,
} from "./babyjub-utils";

// Memo encryption primitives (generic ECIES on BabyJubJub + AES-GCM)
export {
  generateBabyJubKeypair,
  pubkeyFromPrivkey,
  computeSharedSecret,
} from "./babyjub-keypair";
export type { BabyJubKeypair } from "./babyjub-keypair";

// Schema-agnostic ECIES primitives (encrypt/decrypt arbitrary bytes)
export { encryptText } from "./encrypt-text";
export type { MemoCiphertext } from "./encrypt-text";
export { decryptText } from "./decrypt-text";

// Deterministic BabyJub keypair derivation (sign-derive pattern).
export { deriveBabyJubKeypairFromBytes } from "./derive-keypair";

// Protocol-canonical note helpers ({v:1, amt, bld, memo?})
export { encryptNote, decryptNote } from "./note-helpers";

// Checkpoint schema (self-directed snapshot for ShieldedCheckpoint.update())
export { encryptSnapshot, decryptSnapshot } from "./checkpoint-schema";

// Type-only exports
export type { NoteContent, SnapshotContent } from "../types";

// Format-agnostic decrypt — use when token type is unknown.
// When token type is known, use decryptNote() directly.
export { decryptAnyNote, decryptInboxNote } from "./decrypt-any-note";
export type { DecryptedAnyNote } from "./decrypt-any-note";
