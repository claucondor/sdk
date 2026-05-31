/**
 * tokens/ — v0.4 multi-token: JanusToken (abstract) + concrete confidential tokens
 *
 * Concrete tokens shipped:
 *   - JanusFlow  (native FLOW on Flow EVM; v0.3 deployment)
 *   - JanusERC20 (ERC20-wrapping on Flow EVM; v0.4 deployment, MockUSDC default underlying)
 *   - JanusFT    (Cadence-side FungibleToken-wrapping; v0.4 deployment, stub crypto)
 *
 * Privacy property is identical across all three:
 *   - Per-account commitments[user] = Pedersen(value, blinding).
 *   - Homomorphic aggregate `totalSupplyCommitment` (sum of all commits).
 *   - Cleartext `totalLocked` (boundary auditability — VISIBLE BY DESIGN).
 *   - Boundary leaks at wrap/unwrap (amount + underlying movement).
 *   - Full amount privacy on shieldedTransfer (calldata + events + storage).
 *
 * Architecture:
 *
 *   JanusFlow (EVM proxy at 0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078)
 *     — UUPS-upgradeable concrete native-FLOW token. Owner is the v0.3 admin COA.
 *   JanusFlow (Cadence router at 0x5dcbeb41055ec57e)
 *     — Cross-VM façade that funds the user's COA and forwards ABI calldata.
 *
 *   JanusERC20 (EVM proxy at 0xf2C04b1A32B815ac7Ffd87a4C312096592BBCa1e)
 *     — UUPS-upgradeable, pinned to MockUSDC at 0x3e8973dE565743Ef9748779bE377BBE050A13C22.
 *
 *   JanusFT (Cadence contract at 0xbef3c77681c15397)
 *     — Pure-Cadence wrapper for any FungibleToken vault; v0.4 ships with
 *       stub crypto. Real Pedersen + Groth16 verification land in v0.5
 *       via cross-VM calls to the EVM BabyJub.sol + verifier contracts.
 *
 * Usage:
 *
 *   import { JanusFlow, JanusERC20, JanusFTCadence } from "@openjanus/sdk/tokens";
 *
 *   const flow = new JanusFlow();           // canonical testnet defaults
 *   await flow.connectWithSigner(wallet);
 *
 *   const usdc = new JanusERC20();          // canonical testnet defaults
 *   await usdc.connectWithSigner(wallet);
 *
 *   const ft = await new JanusFTCadence({ network: "testnet" }).configure();
 *   const totalLocked = await ft.getTotalLocked();
 *
 * Build the proofs with `buildAmountDiscloseProof` /
 * `buildShieldedTransferProof` from `@openjanus/sdk/crypto`.
 *
 * DEPRECATED (do not use — leaked amount privacy):
 *   v0.2 JanusToken (ElGamal):  0x025efe7e89acdb8F315C804BE7245F348AA9c538
 *   v0.2 Cadence router:        0xbef3c77681c15397 (NOTE: this address now hosts JanusFT v0.4)
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
  TX_WRAP_FROM_COA,
  TX_SHIELDED_TRANSFER,
  TX_UNWRAP,
  TX_UNWRAP_TO_VAULT,
  SCRIPT_GET_TOTAL_LOCKED,
  SCRIPT_GET_ACTIVE_IMPL_VERSION,
  SCRIPT_IS_PAUSED,
  SCRIPT_GET_EVM_TARGET,
  TX_ADMIN_PAUSE,
  TX_ADMIN_UNPAUSE,
  buildWrapCalldata,
  buildShieldedTransferCalldata,
  buildUnwrapCalldata,
  readCommitment,
  readTotalLocked,
  resolveWrapSource,
  // v0.5.4-fees fee helpers
  computeNetWrap,
  computeWrapFee,
  computeNetUnwrap,
  computeUnwrapFee,
  getFeeBps,
  getFeeRecipient,
} from "./janus-flow";
export type {
  JanusFlowCadenceOptions,
  JanusFlowConstructorOptions,
  WrapSource,
  ResolveWrapSourceInput,
  ResolveWrapSourceResult,
  ResolveWrapSourceOk,
  ResolveWrapSourceError,
} from "./janus-flow";

// JanusERC20 concrete ERC20-wrapping token (v0.4)
export {
  JanusERC20,
  JANUS_ERC20_TESTNET,
  JANUS_ERC20_EVM_ADDRESS,
  JANUS_ERC20_EVM_IMPL_ADDRESS,
  JANUS_ERC20_MOCK_USDC_ADDRESS,
  JANUS_ERC20_VERSION,
  JANUS_ERC20_MAX_WRAP_RAW,
  JANUS_ERC20_EXTRA_ABI,
  ERC20_MINIMAL_ABI,
} from "./janus-erc20";
export type { JanusERC20ConstructorOptions } from "./janus-erc20";

// JanusFT Cadence-side FT-wrapping token (v0.4)
export {
  JanusFTCadence,
  JANUS_FT_CADENCE_ADDRESS,
  JANUS_FT_CONTRACT_NAME,
  JANUS_FT_VERSION,
  JANUS_FT_DEFAULT_UNDERLYING_TYPE,
  JANUS_FT_SMOKE_MIRROR_ADDRESS,
  TX_FT_SETUP_REGISTRY,
  TX_FT_WRAP,
  TX_FT_SHIELDED_TRANSFER,
  TX_FT_UNWRAP,
  SCRIPT_FT_GET_TOTAL_LOCKED,
  SCRIPT_FT_GET_COMMITMENT,
  SCRIPT_FT_GET_UNDERLYING_TYPE,
  buildJanusFTTx,
} from "./janus-ft";
export type { JanusFTCadenceOptions } from "./janus-ft";

// Types
export type { TokenOptions, TokenDeployment, Point, FlowNetwork } from "./types";
