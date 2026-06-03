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

// v0.5+ Pedersen commitment (128-bit value range — used by recovery module)
export { computeCommitmentV05 } from "../primitives/pedersen";

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
  parseFlowToWei,
  formatWeiToFlow,
  weiToFlowUFix64,
  assertWholeFlow,
  FLOW_DECIMALS,
  FLOW_SCALE,
} from "./babyjub-utils";

// v0.4.1 memo encryption primitives (generic ECIES on BabyJubJub + AES-GCM)
export {
  generateBabyJubKeypair,
  pubkeyFromPrivkey,
  computeSharedSecret,
} from "./babyjub-keypair";
export type { BabyJubKeypair } from "./babyjub-keypair";

export { encryptText } from "./encrypt-text";
export type { MemoCiphertext } from "./encrypt-text";

export { decryptText } from "./decrypt-text";

// v0.4.5 — Deterministic BabyJub keypair derivation (sign-derive pattern).
// Use with a wallet signature to recover the same MemoKey on any device.
export { deriveBabyJubKeypairFromBytes } from "./derive-keypair";

// v0.4.4 — Shielded note (protocol-level payload that EVERY JanusFlow
// shielded transfer should attach so recipients can decrypt + unwrap).
export { encryptShieldedNote, decryptShieldedNote } from "./shielded-note";
export type { ShieldedNote } from "./shielded-note";

// Snapshot + Note schema (wrap/transfer/unwrap encrypted blobs)
// These are the canonical encode/decode functions for on-chain blobs.
export { encryptSnapshot, decryptSnapshot } from "./snapshot-schema";
export { encryptNote, decryptNote } from "./note-schema";
export type { SnapshotContent, NoteContent } from "../types";
