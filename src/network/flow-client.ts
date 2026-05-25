/**
 * network/flow-client.ts — Flow network configuration and FCL helpers
 *
 * Provides:
 *  - Network configuration for testnet / mainnet
 *  - FCL configuration helpers
 *  - Ethers.js provider factory for Flow EVM
 */

/** Supported Flow networks */
export type FlowNetwork = "testnet" | "mainnet";

/** Network-specific endpoints */
export interface FlowNetworkConfig {
  /** Flow EVM JSON-RPC endpoint (for ethers.js) */
  evmRpc: string;
  /** Flow REST API endpoint (for FCL) */
  flowAccessApi: string;
  /** Flow EVM chain ID */
  chainId: number;
}

/** Network configurations */
export const NETWORK_CONFIG: Record<FlowNetwork, FlowNetworkConfig> = {
  testnet: {
    evmRpc: "https://testnet.evm.nodes.onflow.org",
    flowAccessApi: "https://rest-testnet.onflow.org",
    chainId: 545,
  },
  mainnet: {
    evmRpc: "https://mainnet.evm.nodes.onflow.org",
    flowAccessApi: "https://rest-mainnet.onflow.org",
    chainId: 747,
  },
};

/**
 * Create a read-only ethers.js provider for Flow EVM.
 *
 * @param network  "testnet" | "mainnet"
 * @returns        ethers.JsonRpcProvider
 */
export async function createEvmProvider(network: FlowNetwork) {
  const { ethers } = await import("ethers");
  const config = NETWORK_CONFIG[network];
  return new ethers.JsonRpcProvider(config.evmRpc);
}

/**
 * Create a signing ethers.js wallet from a private key string.
 *
 * @param privateKey  Hex private key (with or without 0x prefix)
 * @param network     Target network
 * @returns           ethers.Wallet connected to Flow EVM
 */
export async function createEvmWallet(privateKey: string, network: FlowNetwork) {
  const { ethers } = await import("ethers");
  const provider = await createEvmProvider(network);
  return new ethers.Wallet(privateKey, provider);
}

/**
 * Configure FCL for the specified network.
 * Call this once at app startup before using any FCL-based functions.
 *
 * @param network  Target network
 */
export async function configureFCL(network: FlowNetwork): Promise<void> {
  const fcl = await import("@onflow/fcl");
  const config = NETWORK_CONFIG[network];

  fcl.config({
    "flow.network": network,
    "accessNode.api": config.flowAccessApi,
  });
}
