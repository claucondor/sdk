/**
 * tokens/ — ElGamal-based JanusToken and JanusFlow
 *
 * Uses additive ElGamal-on-BabyJubJub for multi-sender privacy:
 *   - Any sender can encrypt to any registered recipient pubkey
 *   - Ciphertexts accumulate homomorphically in the slot
 *   - Recipient decrypts the total without learning per-sender amounts
 *   - Proved in Phase 3 e2e: 24/24 tests pass on canonical deployment
 *
 * Quick start:
 *   import { JanusToken, JanusFlow, JANUS_TOKEN_TESTNET } from "@openjanus/sdk/tokens";
 *
 * Migration from v1:
 *   - Replace JanusToken with JanusToken
 *   - Replace JanusFlow with JanusFlow
 *   - Replace computeCommitment+blinding with buildEncryptProof+keypair
 *   - registerPubkey() once before first receive
 *   - See docs/v1-vs-v2.md for full migration guide
 */

// Token classes
export { JanusToken, JANUS_TOKEN_TESTNET, JANUS_TOKEN_ABI } from "./janus-token";
export {
  JanusFlow,
  JANUS_FLOW_CADENCE_ADDRESS,
  JANUS_FLOW_CONTRACT_NAME,
  JANUS_FLOW_VERSION,
  JANUS_FLOW_EVM_ADDRESS,
} from "./janus-flow";

// Contract addresses (for direct use in app code)
export {
  JANUS_BABYJUB_ADDRESS,
  ENCRYPT_CONSISTENCY_VERIFIER,
  DECRYPT_OPEN_VERIFIER,
} from "./janus-token";

// Cadence transaction templates (for custom Cadence integrations)
export {
  TX_REGISTER_PUBKEY,
  TX_WRAP_AND_ENCRYPT,
  TX_CONFIDENTIAL_TRANSFER,
  TX_DECRYPT_AND_UNWRAP,
  SCRIPT_GET_SLOT,
  SCRIPT_GET_PUBKEY,
} from "./janus-flow";

// Types
export type {
  Ciphertext,
  EncryptedSlot,
  DecryptedBalance,
  ElGamalKeypair,
  TokenOptions,
  TokenDeployment,
  EncryptProofInput,
  DecryptProofInput,
  EncryptProofResult,
  DecryptProofResult,
} from "./types";
