/**
 * tests/integration/helpers/testnet.ts
 *
 * Shared testnet config, wallet setup, and utilities for all integration tests.
 *
 * All integration tests are gated by process.env.RUN_INTEGRATION === '1'.
 * Run with: RUN_INTEGRATION=1 npm run test:integration
 *
 * Deployer EOA (Alice): 0xFc47B35f79d26A060B652E112c53d7c6057d05FF
 *   Has FLOW on testnet. Used as the primary funded account.
 * Bob: created fresh per test suite via createFreshBob().
 *   Funded with 0.1 FLOW from deployer in beforeAll.
 */

import { ethers } from "ethers";
import {
  deriveBabyJubKeypairFromBytes,
  FLOW_EVM_RPC,
  TOKEN_REGISTRY,
} from "../../../src/index";
import {
  SHIELDED_INBOX_ADDRESS,
  SHIELDED_CHECKPOINT_ADDRESS,
  MEMO_REGISTRY_ADDRESS,
} from "../../../src/network/contracts";
import type { BabyJubKeypair } from "../../../src/index";

// ---------------------------------------------------------------------------
// Network config
// ---------------------------------------------------------------------------

export const RPC_URL  = FLOW_EVM_RPC;
export const CHAIN_ID = 545;

/** Shared provider — reuse across helpers to avoid connection overhead. */
export const provider = new ethers.JsonRpcProvider(RPC_URL, {
  chainId: CHAIN_ID,
  name: "flow-evm-testnet",
});

// ---------------------------------------------------------------------------
// Deployer (Alice) — funded account on testnet
// ---------------------------------------------------------------------------

export const DEPLOYER_PRIVATE_KEY =
  "0xeae8c16694a157d3093460f606afa40f3a2c65e67299fcc206599469b7661fcb";
export const DEPLOYER_ADDRESS =
  "0xFc47B35f79d26A060B652E112c53d7c6057d05FF";

/** Deployer wallet — use as Alice in tests. */
export function makeDeployerWallet(): ethers.Wallet {
  return new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);
}

// ---------------------------------------------------------------------------
// Addresses
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
// Fresh Bob helper
// ---------------------------------------------------------------------------

export interface FreshAccount {
  wallet: ethers.Wallet;
  address: string;
  fundTxHash: string;
}

/**
 * Create a random EOA and fund it with 0.1 FLOW from the deployer.
 * Call this in beforeAll — do NOT call inside individual tests (costs gas).
 */
export async function createFreshBob(
  amountEth = "0.1"
): Promise<FreshAccount> {
  const deployer = makeDeployerWallet();
  const fresh    = ethers.Wallet.createRandom().connect(provider);

  const tx = await deployer.sendTransaction({
    to:    fresh.address,
    value: ethers.parseEther(amountEth),
  });
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("Fund tx had no receipt");

  return {
    wallet:      fresh,
    address:     fresh.address,
    fundTxHash:  tx.hash,
  };
}

// ---------------------------------------------------------------------------
// BabyJub keypair derivation
// ---------------------------------------------------------------------------

/** Derive a deterministic BabyJub keypair from an EVM address + context. */
export async function deriveMemoKeypair(
  evmAddress: string,
  context = "openjanus/memokey/v1:integration-test"
): Promise<BabyJubKeypair> {
  // Use a 65-byte "signature" derived from the address — deterministic + sufficient entropy.
  const seed = ethers.toUtf8Bytes(
    `${evmAddress.toLowerCase()}:${context}`
  );
  // HKDF needs ≥ 32 bytes input — pad with keccak hash of the seed.
  const padded32 = ethers.getBytes(ethers.keccak256(seed));
  // Extend to 65 bytes by appending another keccak.
  const padded65 = new Uint8Array(65);
  padded65.set(padded32);
  padded65.set(ethers.getBytes(ethers.keccak256(padded32)), 32);
  padded65[64] = 0x1c; // mock recovery byte

  return deriveBabyJubKeypairFromBytes(padded65, "openjanus/memokey/v1");
}

// ---------------------------------------------------------------------------
// Token amounts
// ---------------------------------------------------------------------------

export const ONE_FLOW      = 1n * 10n ** 18n;   // 1 FLOW in attoFLOW
export const HALF_FLOW     = 5n * 10n ** 17n;   // 0.5 FLOW
export const POINT1_FLOW   = 1n * 10n ** 17n;   // 0.1 FLOW
export const TINY_FLOW     = 2n * 10n ** 16n;   // 0.02 FLOW (integration test default)
export const MICRO_FLOW    = 5n * 10n ** 15n;   // 0.005 FLOW
export const ONE_MUSDC     = 1_000_000n;         // 1 mUSDC (6 decimals)
export const TEN_MUSDC     = 10_000_000n;        // 10 mUSDC
export const HUNDRED_MUSDC = 100_000_000n;       // 100 mUSDC

// ---------------------------------------------------------------------------
// Contract ABIs for integration tests (not exported from SDK, needed internally)
// ---------------------------------------------------------------------------

export const JANUS_FLOW_ABI = [
  "function wrapWithProof(uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external payable",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external",
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
  "function totalLocked() view returns (uint256)",
  "function VERSION() view returns (string)",
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event ShieldedTransferNote(address indexed from, address indexed to, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
] as const;

export const JANUS_ERC20_ABI = [
  "function wrapWithProof(uint256 amount, uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external",
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  "function balanceOfCommitmentXY(address account) view returns (uint256 x, uint256 y)",
  "function totalLocked() view returns (uint256)",
  "function VERSION() view returns (string)",
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event ShieldedTransferNote(address indexed from, address indexed to, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
] as const;

export const MOCK_USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
] as const;

export const MEMO_REGISTRY_ABI = [
  "function publishMemoKey(uint256 x, uint256 y) external",
  "function rotateMemoKey(uint256 newX, uint256 newY) external",
  "function getMemoKey(address user) view returns (uint256 x, uint256 y, uint256 publishedAt)",
] as const;

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

/** Throw skip if RUN_INTEGRATION is not set. Use in beforeAll. */
export function skipIfNotIntegration() {
  if (process.env.RUN_INTEGRATION !== "1") {
    throw new Error("SKIP: set RUN_INTEGRATION=1 to run integration tests");
  }
}

// ---------------------------------------------------------------------------
// splitProof helper (mirrors sdk util for direct ethers submission)
// ---------------------------------------------------------------------------

/**
 * Split a uint256[8] flat proof into {pA, pB, pC} arrays for wrapWithProof ABI.
 * Flat layout: [pA0, pA1, pB00, pB01, pB10, pB11, pC0, pC1].
 */
export function splitProofForEvm(flat: readonly bigint[]) {
  return {
    pA: [flat[0], flat[1]] as [bigint, bigint],
    pB: [
      [flat[2], flat[3]],
      [flat[4], flat[5]],
    ] as [[bigint, bigint], [bigint, bigint]],
    pC: [flat[6], flat[7]] as [bigint, bigint],
  };
}
