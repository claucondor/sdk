/**
 * tokens-v2/ — ElGamal-based JanusTokenV2 and JanusFlowV2
 *
 * V2 uses additive ElGamal-on-BabyJubJub for multi-sender privacy:
 *   - Any sender can encrypt to any registered recipient pubkey
 *   - Ciphertexts accumulate homomorphically in the slot
 *   - Recipient decrypts the total without learning per-sender amounts
 *   - Proved in Phase 3 e2e: 24/24 tests pass on canonical deployment
 *
 * Quick start:
 *   import { JanusTokenV2, JanusFlowV2, JANUS_TOKEN_V2_TESTNET } from "@openjanus/sdk/tokens-v2";
 *
 * Migration from v1:
 *   - Replace JanusToken with JanusTokenV2
 *   - Replace JanusFlow with JanusFlowV2
 *   - Replace computeCommitment+blinding with buildEncryptProof+keypair
 *   - registerPubkey() once before first receive
 *   - See docs/v1-vs-v2.md for full migration guide
 */

// Token classes
export { JanusTokenV2, JANUS_TOKEN_V2_TESTNET, JANUS_TOKEN_V2_ABI } from "./janus-token-v2";
export {
  JanusFlowV2,
  JANUS_FLOW_V2_CADENCE_ADDRESS,
  JANUS_FLOW_V2_CONTRACT_NAME,
  JANUS_FLOW_V2_VERSION,
  JANUS_FLOW_V2_EVM_ADDRESS,
} from "./janus-flow-v2";

// Contract addresses (for direct use in app code)
export {
  JANUS_V2_BABYJUB_ADDRESS,
  ENCRYPT_CONSISTENCY_VERIFIER,
  DECRYPT_OPEN_VERIFIER,
} from "./janus-token-v2";

// Cadence transaction templates (for custom Cadence integrations)
export {
  TX_REGISTER_PUBKEY,
  TX_WRAP_AND_ENCRYPT,
  TX_CONFIDENTIAL_TRANSFER_V2,
  TX_DECRYPT_AND_UNWRAP,
  SCRIPT_GET_SLOT,
  SCRIPT_GET_PUBKEY,
} from "./janus-flow-v2";

// Types
export type {
  Ciphertext,
  EncryptedSlot,
  DecryptedBalance,
  ElGamalKeypair,
  TokenV2Options,
  TokenV2Deployment,
  EncryptProofInput,
  DecryptProofInput,
  EncryptProofResult,
  DecryptProofResult,
} from "./types";
