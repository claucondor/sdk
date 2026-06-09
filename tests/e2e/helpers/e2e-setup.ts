/**
 * tests/e2e/helpers/e2e-setup.ts
 *
 * E2E test setup using ONLY SDK public API.
 * No direct ethers.Contract instantiations — all calls go through SDK exports.
 *
 * Exports:
 *   - makeProvider(): async factory returning an ethers.JsonRpcProvider via SDK
 *   - makeAlice(): async factory returning the deployer signer
 *   - createFundedAccount(): create a fresh random EOA funded from the deployer
 *   - deriveMemoJub(): deterministic BabyJub keypair from EVM address + context
 *   - sdk: re-export of the SDK singleton
 *   - AMOUNTS: useful token amounts
 *   - RUN_E2E: E2E gate boolean
 *   - ADDRESSES: deployed contract addresses
 */

import { ethers } from "ethers";
import {
  sdk,
  TOKEN_REGISTRY,
  FLOW_EVM_RPC,
  SHIELDED_INBOX_ADDRESS,
  SHIELDED_CHECKPOINT_ADDRESS,
  MEMO_REGISTRY_ADDRESS,
  deriveBabyJubKeypairFromBytes,
} from "../../../src/index";
import type { BabyJubKeypair } from "../../../src/index";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------
export { sdk };
export { TOKEN_REGISTRY };

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------
export const RUN_E2E = process.env.RUN_E2E === "1";

/** Call in beforeAll to skip E2E suite when flag not set. */
export function skipIfNotE2E() {
  if (!RUN_E2E) throw new Error("SKIP: set RUN_E2E=1 to run E2E tests");
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
export const CHAIN_ID = 545;

/** Shared provider factory — creates via SDK's FLOW_EVM_RPC constant. */
export function makeProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(FLOW_EVM_RPC, {
    chainId: CHAIN_ID,
    name: "flow-evm-testnet",
  });
}

// ---------------------------------------------------------------------------
// Deployer (Alice) — stable funded account
// ---------------------------------------------------------------------------
export const DEPLOYER_PRIVATE_KEY =
  "0xeae8c16694a157d3093460f606afa40f3a2c65e67299fcc206599469b7661fcb";
export const DEPLOYER_ADDRESS =
  "0xFc47B35f79d26A060B652E112c53d7c6057d05FF";

/** Alice = deployer signer (funded on testnet). */
export function makeAlice(): ethers.Wallet {
  return new ethers.Wallet(DEPLOYER_PRIVATE_KEY, makeProvider());
}

// ---------------------------------------------------------------------------
// Fresh account factory
// ---------------------------------------------------------------------------

export interface FundedAccount {
  wallet: ethers.Wallet;
  address: string;
  fundTxHash: string;
}

/**
 * Create a fresh random EOA and fund it from the deployer.
 * Uses ethers.Wallet.sendTransaction (not ethers.Contract).
 */
export async function createFundedAccount(amountEth = "0.1"): Promise<FundedAccount> {
  const provider = makeProvider();
  const alice    = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);
  const fresh    = ethers.Wallet.createRandom().connect(provider);

  const tx = await alice.sendTransaction({
    to:    fresh.address,
    value: ethers.parseEther(amountEth),
  });
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("Fund tx has no receipt");

  return {
    wallet:     fresh,
    address:    fresh.address,
    fundTxHash: tx.hash,
  };
}

// ---------------------------------------------------------------------------
// BabyJub keypair derivation (SDK public API)
// ---------------------------------------------------------------------------

/** Derive a deterministic BabyJub keypair from EVM address + context string. */
export async function deriveMemoJub(
  evmAddress: string,
  context = "openjanus/memokey/v1:e2e-test",
): Promise<BabyJubKeypair> {
  const seed     = ethers.toUtf8Bytes(`${evmAddress.toLowerCase()}:${context}`);
  const padded32 = ethers.getBytes(ethers.keccak256(seed));
  const padded65 = new Uint8Array(65);
  padded65.set(padded32);
  padded65.set(ethers.getBytes(ethers.keccak256(padded32)), 32);
  padded65[64] = 0x1c;
  return deriveBabyJubKeypairFromBytes(padded65, "openjanus/memokey/v1");
}

// ---------------------------------------------------------------------------
// Addresses (from SDK constants)
// ---------------------------------------------------------------------------
export const ADDRESSES = {
  janusFlow:          TOKEN_REGISTRY.flow.proxy,
  janusERC20:         TOKEN_REGISTRY.mockusdc.proxy,
  mockUSDC:           TOKEN_REGISTRY.mockusdc.underlying,
  memoKeyRegistry:    MEMO_REGISTRY_ADDRESS,
  shieldedInbox:      SHIELDED_INBOX_ADDRESS,
  shieldedCheckpoint: SHIELDED_CHECKPOINT_ADDRESS,
} as const;

// ---------------------------------------------------------------------------
// Token amounts
// ---------------------------------------------------------------------------
export const AMOUNTS = {
  ONE_FLOW:      1n * 10n ** 18n,
  HALF_FLOW:     5n * 10n ** 17n,
  POINT3_FLOW:   3n * 10n ** 17n,
  POINT1_FLOW:   1n * 10n ** 17n,
  ONE_MUSDC:     1_000_000n,
  TEN_MUSDC:     10_000_000n,
  THREE_MUSDC:   3_000_000n,
  HUNDRED_MUSDC: 100_000_000n,
} as const;
