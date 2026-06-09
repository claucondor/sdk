/**
 * network/index.ts — Network module public surface
 */

export type { FlowNetwork, FlowNetworkConfig } from "./flow-client";
export { NETWORK_CONFIG, createEvmProvider, createEvmWallet, configureFCL } from "./flow-client";

export {
  TOKEN_REGISTRY,
  VERIFIERS,
  MEMO_REGISTRY_ADDRESS,
  DEFAULT_FEE_BPS,
  FLOW_EVM_RPC,
  FLOW_CADENCE_ACCESS,
  UFIX64_SCALE,
  SHIELDED_INBOX_ADDRESS,
  SHIELDED_CHECKPOINT_ADDRESS,
  LEGACY_V071_JANUSFLOW_PROXY,
  CADENCE_DEPLOYER_ADDRESS,
  COA_DEPLOYER_EVM_ADDRESS,
} from "./contracts";

export {
  KNOWN_COAS,
  SCRIPT_GET_COA_ADDRESS,
  TX_SETUP_COA,
  getKnownCOA,
  getCOAAddressOnChain,
  getCoaEvmAddress,
  hasCOA,
  getCoaBalanceWei,
  getFlowVaultBalanceWei,
} from "./coa";
