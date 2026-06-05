/**
 * network/contracts.ts — TOKEN_REGISTRY and VERIFIERS
 *
 * Single source of truth for all v0.7 testnet addresses.
 * The SDK never hard-codes addresses anywhere else — import from here.
 *
 * TOKEN_REGISTRY keys are the stable token IDs used by sdk.token(id).
 * VERIFIERS holds the shared Groth16 verifier addresses (same across all tokens).
 *
 * All addresses from v0.7 clean deploy (2026-06-04).
 * Chain ID: 545 (Flow EVM testnet).
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
    proxy: "0x9A83732417947Ef9b7AEa64bF807a345267c2FdA",
    decimals: 18,
  } satisfies NativeTokenEntry,

  mockusdc: {
    variant: "erc20",
    proxy: "0xD5E6a52635599E6B2296B5BfEeC617E333561ea0",
    // JanusERC20_impl: 0xBbF98D59825730F421DA406c6DDbeBe16860fe27 (post-fix deploy 2026-06-04)
    // Original impl had underlying=address(0); fixed by deploying new impl with
    // reinitializeUnderlying(address) and upgrading via admin COA.
    underlying: "0x686E8d90A7B608540cAF46E527fD8a5631A1b658", // MockUSDC
    decimals: 6,
  } satisfies ERC20TokenEntry,

  mockft: {
    variant: "cadence-ft",
    // cadenceAddress: JanusFT wrapper contract (aggregate v0.7, migrated 2026-06-05).
    // Deployed under v066-admin account — holds CommitmentRegistry + aggregate verifier calls.
    cadenceAddress: "0xc4e8f99915893a2f",
    contractName: "JanusFT",
    // ftAddress: underlying MockFT FT contract (unchanged — was NOT redeployed).
    // The old address (0x7599043aea001283) was the v0.6 JanusFT wrapper; MockFT still lives there.
    ftAddress: "0x7599043aea001283",
    ftContractName: "MockFT",
    decimals: 8, // UFix64 internal: 1.0 = 100_000_000
  } satisfies CadenceFTTokenEntry,
} as const;

export type TokenId = keyof typeof TOKEN_REGISTRY;

export const VERIFIERS = {
  babyJub: "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870",
  /** ConfidentialTransferAggregateVerifier — aggregate 2-gen Pedersen transfer circuit */
  transferVerifier: "0x5702A545d2853b03B808aEA331f892c121b67243",
  /** AmountDiscloseAggregateVerifier — aggregate 2-gen Pedersen amount-disclose circuit */
  amountDiscloseVerifier: "0xa80283baB7fcEFC2c75De43DB5a1cBF00E96B984",
} as const;

/**
 * AmountDiscloseAggregateVerifier — convenience alias for the aggregate verifier.
 * Same value as VERIFIERS.amountDiscloseVerifier; exported separately for
 * callers that only need the amount-disclose verifier address.
 */
export const AGGREGATE_AMOUNT_DISCLOSE_VERIFIER =
  "0xa80283baB7fcEFC2c75De43DB5a1cBF00E96B984";

/**
 * Shared MemoKeyRegistry — deployed once, read by all Janus EVM token proxies.
 * EVM-only users call publishMemoKey() directly on this contract (one tx covers
 * all tokens). Cadence users call the cross-VM transaction publish_memokey_xvm.cdc
 * which calls this registry from their COA in the same tx that writes to Cadence
 * storage. Introduced in v0.6.3 (Track B++).
 */
export const MEMO_REGISTRY_ADDRESS = "0x05D104962ff087441f26BA11A1E1C3b9E091D663";

/**
 * Pedersen2Gen library address (on-chain 2-gen Pedersen math, used by v0.7 contracts).
 */
export const PEDERSEN_2GEN_LIBRARY = "0xb8Af0091A010E082b05d0c55E1019c3833E15760";

/**
 * Fee rate used by all v0.7 deployed contracts.
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
