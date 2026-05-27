/**
 * tokens/ — v0.3 Pedersen-based JanusToken (abstract) + JanusFlow (concrete native FLOW)
 *
 * v0.3 ships a fully shielded Pedersen-commit confidential token:
 *
 *   - Per-account commitments[user] = Pedersen(value, blinding).
 *   - Homomorphic aggregate `totalSupplyCommitment` (sum of all commits).
 *   - Cleartext `totalLocked` (boundary auditability — VISIBLE BY DESIGN).
 *   - Boundary leaks (intentional): msg.value at wrap, claimedAmount + recipient at unwrap.
 *   - Full amount privacy on shieldedTransfer (calldata + events + storage).
 *
 * Architecture:
 *
 *   JanusFlow (EVM proxy at 0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078)
 *     — UUPS-upgradeable concrete native-FLOW token. Owner is the v0.3 admin COA.
 *   JanusFlow (Cadence router at 0x5dcbeb41055ec57e)
 *     — Cross-VM façade that funds the user's COA and forwards ABI calldata
 *       to the EVM proxy. Cadence-side mirror of `totalLocked` only.
 *
 * Use the generic primitive API:
 *
 *   import { JanusFlow } from "@openjanus/sdk/tokens";
 *
 *   const flow = new JanusFlow();          // canonical testnet defaults
 *   await flow.connectWithSigner(wallet);  // ethers v6 signer
 *
 *   await flow.wrap({ amountWei, txCommit, amountProof });
 *   await flow.shieldedTransfer({ to, publicInputs, proof });
 *   await flow.unwrap({ claimedAmountWei, recipient, txCommit,
 *                        amountProof, transferPublicInputs, transferProof });
 *
 * Build the proofs with `buildAmountDiscloseProof` /
 * `buildShieldedTransferProof` from `@openjanus/sdk/crypto`.
 *
 * DEPRECATED (do not use — leaked amount privacy):
 *   v0.2 JanusToken (ElGamal):  0x025efe7e89acdb8F315C804BE7245F348AA9c538
 *   v0.2 Cadence router:        0xbef3c77681c15397
 *   v0.1 zombie:                0x28fef3d1d6a12800
 */

// JanusToken abstract base
export {
  JanusToken,
  JANUS_TOKEN_BASE_ABI,
  JANUS_BABYJUB_ADDRESS,
  AMOUNT_DISCLOSE_VERIFIER,
  CONFIDENTIAL_TRANSFER_VERIFIER,
  JANUS_TOKEN_OWNER_EVM,
  JANUS_TOKEN_DEPRECATED_ADDRESSES,
} from "./janus-token";
export type { JanusTokenOptions } from "./janus-token";

// JanusFlow concrete native-FLOW token + Cadence router helper
export {
  JanusFlow,
  JanusFlowCadence,
  JANUS_FLOW_TESTNET,
  JANUS_FLOW_EVM_ADDRESS,
  JANUS_FLOW_EVM_IMPL_ADDRESS,
  JANUS_FLOW_CADENCE_ADDRESS,
  JANUS_FLOW_CONTRACT_NAME,
  JANUS_FLOW_VERSION,
  JANUS_FLOW_MAX_WRAP_ATTOFLOW,
  JANUS_FLOW_EXTRA_ABI,
  JANUS_FLOW_EVM_ADDRESS_DEPRECATED_V02,
  JANUS_FLOW_CADENCE_ADDRESS_PREVIOUS,
  JANUS_FLOW_CADENCE_ADDRESS_LEGACY,
  TX_WRAP,
  TX_SHIELDED_TRANSFER,
  TX_UNWRAP,
  SCRIPT_GET_TOTAL_LOCKED,
  SCRIPT_GET_ACTIVE_IMPL_VERSION,
  SCRIPT_IS_PAUSED,
  SCRIPT_GET_EVM_TARGET,
  TX_ADMIN_PAUSE,
  TX_ADMIN_UNPAUSE,
} from "./janus-flow";
export type { JanusFlowCadenceOptions, JanusFlowConstructorOptions } from "./janus-flow";

// Types
export type { TokenOptions, TokenDeployment, Point, FlowNetwork } from "./types";
