/**
 * network/contracts.ts — TOKEN_REGISTRY and VERIFIERS
 *
 * Single source of truth for all v0.6 testnet addresses.
 * The SDK never hard-codes addresses anywhere else — import from here.
 *
 * TOKEN_REGISTRY keys are the stable token IDs used by sdk.token(id).
 * VERIFIERS holds the shared Groth16 verifier addresses (same across all tokens).
 *
 * All addresses confirmed from Track A+/B/B+ deployments (2026-05-31).
 */

import type {
  NativeTokenEntry,
  ERC20TokenEntry,
  CadenceFTTokenEntry,
} from "../types";

export const TOKEN_REGISTRY = {
  flow: {
    variant: "native",
    proxy: "0x2458ae2d26797c2ffa3B4f6612Bdc4aDf22b7156",
    decimals: 18,
  } satisfies NativeTokenEntry,

  wflow: {
    variant: "erc20",
    proxy: "0x00129E94d5340bd19d0b4ed9CDf718BB6e0A9400",
    underlying: "0xe7BbEAcC04A589e4B70922b2796Bb4F8e6e4873C", // WFLOW9
    decimals: 18,
  } satisfies ERC20TokenEntry,

  mockusdc: {
    variant: "erc20",
    proxy: "0xd45FDa099Cf67eD842eA379865AB08E18D62BAf3",
    underlying: "0x8405E8831737aE72204c271581b7d4fAD9f622bE", // MockUSDC
    decimals: 6,
  } satisfies ERC20TokenEntry,

  mockft: {
    variant: "cadence-ft",
    cadenceAddress: "0x7599043aea001283",
    // contractName changed from 'JanusMockFT' → 'JanusFT' (Track B+++).
    // The registry key stays 'mockft' — it identifies the JanusFT instance
    // that wraps MockFT (the testnet-only underlying). 'mockft' is a stable
    // token-registry id, not a contract name. Only the contractName changes.
    contractName: "JanusFT",
    ftAddress: "0x7599043aea001283",
    ftContractName: "MockFT",
    decimals: 8, // UFix64 internal: 1.0 = 100_000_000
  } satisfies CadenceFTTokenEntry,
} as const;

export type TokenId = keyof typeof TOKEN_REGISTRY;

export const VERIFIERS = {
  babyJub: "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870",
  transferVerifier: "0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B",
  amountDiscloseVerifier: "0xD0ED3936530258C278f5357C1dB709ad34768352",
} as const;

/**
 * Shared MemoKeyRegistry — deployed once, read by all Janus EVM token proxies.
 * EVM-only users call publishMemoKey() directly on this contract (one tx covers
 * all tokens). Cadence users call the cross-VM transaction publish_memokey_xvm.cdc
 * which calls this registry from their COA in the same tx that writes to Cadence
 * storage. Introduced in v0.6.3 (Track B++).
 */
export const MEMO_REGISTRY_ADDRESS = "0x05D104962ff087441f26BA11A1E1C3b9E091D663";

/**
 * Fee rate used by all v0.6 deployed contracts.
 * 10 bps = 0.1%. The SDK reads this from chain for each operation
 * but this constant is used in tests and fee previews.
 */
export const DEFAULT_FEE_BPS = 10;

/**
 * UFix64 scale factor: 1.0 UFix64 = 100_000_000 (10^8) in Cadence internal units.
 */
export const UFIX64_SCALE = 100_000_000n;

/**
 * Flow EVM testnet RPC.
 */
export const FLOW_EVM_RPC = "https://testnet.evm.nodes.onflow.org";

/**
 * Flow Cadence testnet access node.
 */
export const FLOW_CADENCE_ACCESS = "https://rest-testnet.onflow.org";
