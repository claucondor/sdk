/**
 * tokens/ — ElGamal-based JanusToken (EVM) and JanusFlow (Cadence router)
 *
 * Uses additive ElGamal-on-BabyJubJub for multi-sender privacy:
 *   - Any sender can encrypt to any registered recipient pubkey
 *   - Ciphertexts accumulate homomorphically in the slot
 *   - Recipient decrypts the total without learning per-sender amounts
 *
 * Architecture — Router/Impl pattern with UUPS EVM proxy:
 *   JanusToken (EVM proxy) at 0x025efe7e89acdb8F315C804BE7245F348AA9c538
 *     — public forever, UUPS-upgradeable; impl swap via owner-gated upgradeToAndCall.
 *   JanusFlow (Cadence router) at 0x5dcbeb41055ec57e
 *     — public forever, holds Cadence-side custody; impl swap via 48h time-lock.
 *
 * Vuln 014 (SCALE unit mismatch) is fixed in the current deployment. unwrap takes
 * whole-FLOW units and multiplies by 1e18 internally.
 *
 * DEPRECATED — DO NOT USE:
 *   0xb12E600fFcde967210cFD81CF9f32bBB6e68a499 — pre-SCALE-fix JanusToken
 *   0xbef3c77681c15397 — previous Cadence router (48h time-lock blocked v0.2.1 fix)
 *   0x28fef3d1d6a12800 — legacy v1 Pedersen zombie, cannot be removed
 *
 * Quick start:
 *   import { JanusToken, JanusFlow, JANUS_TOKEN_TESTNET } from "@openjanus/sdk/tokens";
 */

// Token classes
export {
  JanusToken,
  JANUS_TOKEN_TESTNET,
  JANUS_TOKEN_ABI,
  JANUS_TOKEN_DEPRECATED_ADDRESSES,
} from "./janus-token";
export {
  JanusFlow,
  JANUS_FLOW_CADENCE_ADDRESS,
  JANUS_FLOW_CADENCE_ADDRESS_LEGACY,
  JANUS_FLOW_CADENCE_ADDRESS_PREVIOUS,
  JANUS_FLOW_CONTRACT_NAME,
  JANUS_FLOW_VERSION,
  JANUS_FLOW_EVM_ADDRESS,
  JANUS_FLOW_EVM_ADDRESS_DEPRECATED,
} from "./janus-flow";

// Canonical address constants (use these in app code)
export const JANUS_TOKEN_EVM = "0x025efe7e89acdb8F315C804BE7245F348AA9c538";
export const ENCRYPT_VERIFIER_EVM = "0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e";
export const DECRYPT_VERIFIER_EVM = "0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc";

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
  SCRIPT_IS_PAUSED,
  SCRIPT_GET_ACTIVE_IMPL_VERSION,
  // Admin templates — require AdminResource at /storage/janusFlowAdmin
  TX_ADMIN_PAUSE,
  TX_ADMIN_UNPAUSE,
  TX_ADMIN_PROPOSE_IMPL_SWAP,
  TX_ADMIN_FINALIZE_IMPL_SWAP,
  TX_ADMIN_CANCEL_IMPL_SWAP,
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
