/**
 * network/contracts.ts — TOKEN_REGISTRY and VERIFIERS
 *
 * Single source of truth for all v0.6.6 testnet addresses.
 * The SDK never hard-codes addresses anywhere else — import from here.
 *
 * TOKEN_REGISTRY keys are the stable token IDs used by sdk.token(id).
 * VERIFIERS holds the shared Groth16 verifier addresses (same across all tokens).
 *
 * All addresses from v0.6.6 clean deploy (2026-06-03).
 * Admin: Cadence 0xc4e8f99915893a2f, COA 0x000000000000000000000002656f9205e386ed78
 */

import type {
  NativeTokenEntry,
  ERC20TokenEntry,
  CadenceFTTokenEntry,
} from "../types";

export const TOKEN_REGISTRY = {
  flow: {
    variant: "native",
    proxy: "0x2f4b9b63C869076c9dBE89626e340Fc7741fcE59",
    decimals: 18,
  } satisfies NativeTokenEntry,

  // wflow: NOT redeployed in v0.6.6 — address retained from prior deploy for
  // PrivateTip backward compatibility. State on this proxy may be stale.
  // Do not use for new transactions until a fresh wflow proxy is deployed.
  wflow: {
    variant: "erc20",
    proxy: "0x00129E94d5340bd19d0b4ed9CDf718BB6e0A9400",
    underlying: "0xe7BbEAcC04A589e4B70922b2796Bb4F8e6e4873C", // WFLOW9
    decimals: 18,
  } satisfies ERC20TokenEntry,

  mockusdc: {
    variant: "erc20",
    proxy: "0x4689a36427115a6023BEb8c8b3c38E6fDF5Ae84F",
    underlying: "0x686E8d90A7B608540cAF46E527fD8a5631A1b658", // MockUSDC v0.6.6
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
