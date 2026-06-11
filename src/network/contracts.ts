/**
 * network/contracts.ts — TOKEN_REGISTRY and contract addresses for v0.8
 *
 * Single source of truth for all v0.8 testnet addresses.
 * The SDK never hard-codes addresses anywhere else — import from here.
 *
 * TOKEN_REGISTRY keys are the stable token IDs used by sdk.token(id).
 *
 * All addresses from v0.8 clean deploy (2026-06-09).
 * Chain ID: 545 (Flow EVM testnet).
 * Admin: Cadence 0x4b6bc58bc8bf5dcc, COA 0x0000000000000000000000020885d7ad3582356a
 *
 * v0.8 changes from v0.7:
 *   - New ShieldedInbox + ShieldedCheckpoint contracts (immutable)
 *   - New JanusFlow + JanusERC20 proxies (6-arg shieldedTransfer)
 *   - New ConfidentialTransfer + AmountDisclose aggregate verifiers
 *   - New MemoKeyRegistry address
 *   - All Cadence contracts at 0x4b6bc58bc8bf5dcc
 *   - LEGACY_V071_JANUSFLOW_PROXY constant preserved for PrivateTip demo
 *
 * ─── Supported env vars (all optional — testnet values are the fallbacks) ───
 *
 *   FLOW_EVM_RPC            — EVM JSON-RPC endpoint
 *                             default: https://testnet.evm.nodes.onflow.org
 *   MEMO_REGISTRY_ADDRESS   — MemoKeyRegistry EVM contract address
 *                             default: 0x361bD4d037838A3a9c5408AE465d36077800ee6c
 *   JANUS_FLOW_PROXY        — JanusFlow (native FLOW) EVM proxy address
 *                             default: 0xA64340C1d356835A2450306Ffd290Ed52c001Ad3
 *   JANUS_ERC20_PROXY       — JanusERC20 (mUSDC) EVM proxy address
 *                             default: 0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d
 *   JANUS_ERC20_UNDERLYING  — MockUSDC (mUSDC) EVM underlying token address
 *                             default: 0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524
 *   MOCKFT_CADENCE_ADDRESS  — Cadence deployer address for JanusFT + MockFT
 *                             default: 0x4b6bc58bc8bf5dcc
 *
 * Note: FungibleToken core address (0x9a0766d93b6608b7) is a Flow testnet
 * system contract — not configurable per project, intentionally hard-coded.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  NativeTokenEntry,
  ERC20TokenEntry,
  CadenceFTTokenEntry,
} from "../types";

export const TOKEN_REGISTRY = {
  flow: {
    variant: "native",
    proxy: process.env.JANUS_FLOW_PROXY ?? "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3",
    decimals: 18,
  } satisfies NativeTokenEntry,

  mockusdc: {
    variant: "erc20",
    proxy: process.env.JANUS_ERC20_PROXY ?? "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d",
    underlying: process.env.JANUS_ERC20_UNDERLYING ?? "0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524", // MockUSDC (mUSDC)
    decimals: 6,
  } satisfies ERC20TokenEntry,

  mockft: {
    variant: "cadence-ft",
    cadenceAddress: process.env.MOCKFT_CADENCE_ADDRESS ?? "0x4b6bc58bc8bf5dcc",
    contractName: "JanusFT",
    ftAddress: process.env.MOCKFT_CADENCE_ADDRESS ?? "0x4b6bc58bc8bf5dcc",
    ftContractName: "MockFT",
    decimals: 8, // UFix64 internal: 1.0 = 100_000_000
  } satisfies CadenceFTTokenEntry,
} as const;

export type TokenId = keyof typeof TOKEN_REGISTRY;

export const VERIFIERS = {
  babyJub: "0xD79C90b797949F0956d977989aEf82A81c860e0C",
  pedersen2Gen: "0x5EdF7473b1007b4855127bC40fcc89eCDD7fB561",
  /** ConfidentialTransferAggregateVerifier — v0.8 re-deployed */
  transferVerifier: "0x38e69fE7Ba7c2C586d64DFFc14742641A675666c",
  /** AmountDiscloseAggregateVerifier — v0.8 re-deployed */
  amountDiscloseVerifier: "0xf7B634D41259D0613345633eE1CD193A030A6329",
  /** ConfidentialClaimBatchVerifier — N=10 re-deployed (v0.8.1-alpha.4) */
  claimBatchVerifier: "0x66f25B8f2e7ABFA97ff6446aEAfE5c5D3b1c8d2f",
} as const;

/**
 * ShieldedInbox — per-user on-chain mailbox shared across all JanusFlow/ERC20/FT tokens.
 * Immutable contract (no proxy). Recipients drain their inbox instead of scanning events.
 */
export const SHIELDED_INBOX_ADDRESS = "0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6";

/**
 * ShieldedCheckpoint — per-user, per-token encrypted state store for sender balance recovery.
 * Immutable contract (no proxy). Senders update their checkpoint after each transfer.
 * v0.8.2 re-deploy: multi-token support (token address as first arg on all write/read methods).
 * Deployed: 2026-06-11 (A.4 sprint).
 */
export const SHIELDED_CHECKPOINT_ADDRESS = "0x88C9fD443BC15d1Cd24bc724DB6928D3246b2E26";

/**
 * ARCHIVED — singleton ShieldedCheckpoint from v0.8.0/0.8.1 (single-slot, no token param).
 * Do NOT use for new writes. Preserved for reference only.
 * NOT exported from SDK index.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const SHIELDED_CHECKPOINT_ADDRESS_ARCHIVE_SINGLETON = "0xbF8dbE133FC1319570dBe43E32BFD9a6D64E1E76";

/**
 * Shared MemoKeyRegistry — v0.8 deployment.
 * All EVM Janus tokens share this registry. One publishMemoKey() call covers all.
 */
export const MEMO_REGISTRY_ADDRESS =
  process.env.MEMO_REGISTRY_ADDRESS ?? "0x361bD4d037838A3a9c5408AE465d36077800ee6c";

/**
 * Pedersen2Gen library address on-chain.
 */
export const PEDERSEN_2GEN_LIBRARY = "0x5EdF7473b1007b4855127bC40fcc89eCDD7fB561";

/**
 * v0.7.1 JanusFlow proxy — still live, serves the PrivateTip demo at
 * 0x9A83732417947Ef9b7AEa64bF807a345267c2FdA. Do NOT recycle or remove.
 * Exported so any code that previously imported TOKEN_REGISTRY.flow.proxy
 * and needs to reference the old demo contract can find this constant.
 */
export const LEGACY_V071_JANUSFLOW_PROXY = "0x9A83732417947Ef9b7AEa64bF807a345267c2FdA";

/**
 * Fee rate used by all v0.8 deployed contracts.
 * 10 bps = 0.1%.
 */
export const DEFAULT_FEE_BPS = 10;

/**
 * UFix64 scale factor: 1.0 UFix64 = 100_000_000 (10^8) in Cadence internal units.
 */
export const UFIX64_SCALE = 100_000_000n;

/**
 * Flow EVM testnet RPC.
 */
export const FLOW_EVM_RPC =
  process.env.FLOW_EVM_RPC ?? "https://testnet.evm.nodes.onflow.org";

/**
 * Flow Cadence testnet access node.
 */
export const FLOW_CADENCE_ACCESS = "https://rest-testnet.onflow.org";

/**
 * Cadence deployer address for all v0.8 contracts.
 */
export const CADENCE_DEPLOYER_ADDRESS = "0x4b6bc58bc8bf5dcc";

/**
 * COA EVM address of the Cadence deployer (owner of all EVM proxies).
 * Admin calls to JanusFlow/JanusERC20 must go through this COA via Cadence.
 */
export const COA_DEPLOYER_EVM_ADDRESS = "0x0000000000000000000000020885d7ad3582356a";
