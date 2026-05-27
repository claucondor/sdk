/**
 * network/index.ts — Network module public surface
 */

export type { FlowNetwork, FlowNetworkConfig } from "./flow-client";
export { NETWORK_CONFIG, createEvmProvider, createEvmWallet, configureFCL } from "./flow-client";

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
