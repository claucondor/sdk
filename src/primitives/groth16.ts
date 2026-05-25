/**
 * primitives/groth16.ts — Groth16 proof generation and verification helpers
 *
 * Wraps snarkjs with:
 *   - Automatic pi_b Fp2 swap (EIP-197 encoding) — see utils/pi-b-swap.ts
 *   - On-chain verification via deployed ConfidentialTransferVerifier
 *   - Local verification via snarkjs (no network)
 *   - Typed public signal handling for the ConfidentialTransfer circuit
 *
 * Deployed verifier:
 *   ConfidentialTransferVerifier.sol: 0x0085F286d89af79EC59E27CD0c5CcD1c55f42Cf5 (Flow EVM testnet)
 */

import type {
  SnarkJSProof,
  EVMProof,
  ConfidentialTransferPublicInputs,
  ProofUint256,
  PublicInputsUint256,
} from "../types/proof";
import { applyPiBSwap, evmProofToUint256Array } from "../utils/pi-b-swap";

export type {
  SnarkJSProof,
  EVMProof,
  ConfidentialTransferPublicInputs,
  ProofUint256,
  PublicInputsUint256,
};

// ---------------------------------------------------------------------------
// Deployed addresses
// ---------------------------------------------------------------------------

/** ConfidentialTransferVerifier.sol on Flow EVM testnet */
export const VERIFIER_ADDRESS = "0x0085F286d89af79EC59E27CD0c5CcD1c55f42Cf5";

/** Flow EVM testnet RPC */
export const FLOW_EVM_TESTNET_RPC = "https://testnet.evm.nodes.onflow.org";

/** ABI selector for verifyProof — 4 bytes */
export const VERIFY_PROOF_SELECTOR = "0xf398789b";

// ---------------------------------------------------------------------------
// pi_b swap (re-export from utils for backward compatibility)
// ---------------------------------------------------------------------------

/** Convert a snarkJS proof to EVM-ready format (applies pi_b Fp2 swap). */
export { applyPiBSwap as proofToEVMFormat } from "../utils/pi-b-swap";

// ---------------------------------------------------------------------------
// Public signal helpers
// ---------------------------------------------------------------------------

/**
 * Convert ConfidentialTransfer public signals to the ordered array
 * expected by verifyProof().
 *
 * Signal order (per circuit declaration):
 *   [0] old_commit.x, [1] old_commit.y
 *   [2] transfer_commit.x, [3] transfer_commit.y
 *   [4] new_commit.x, [5] new_commit.y
 */
export function pubSignalsToArray(
  signals: ConfidentialTransferPublicInputs
): PublicInputsUint256 {
  return [
    signals.oldCommitX,
    signals.oldCommitY,
    signals.transferCommitX,
    signals.transferCommitY,
    signals.newCommitX,
    signals.newCommitY,
  ];
}

/**
 * Parse the raw snarkJS public signals array (decimal strings) into typed object.
 */
export function parsePublicSignals(raw: string[]): ConfidentialTransferPublicInputs {
  if (raw.length !== 6) {
    throw new Error(`parsePublicSignals: expected 6 signals, got ${raw.length}`);
  }
  return {
    oldCommitX: BigInt(raw[0]),
    oldCommitY: BigInt(raw[1]),
    transferCommitX: BigInt(raw[2]),
    transferCommitY: BigInt(raw[3]),
    newCommitX: BigInt(raw[4]),
    newCommitY: BigInt(raw[5]),
  };
}

// ---------------------------------------------------------------------------
// On-chain verification
// ---------------------------------------------------------------------------

export interface VerifyOnChainOptions {
  rpc?: string;
  address?: string;
}

/**
 * Call the deployed ConfidentialTransferVerifier on Flow EVM testnet.
 * Automatically applies the pi_b Fp2 swap before calling.
 *
 * @param proof         Raw snarkJS proof
 * @param publicSignals Raw snarkJS public signals (6 decimal strings)
 * @param opts          RPC and address overrides
 * @returns             true if the proof is valid on-chain
 */
export async function verifyOnChain(
  proof: SnarkJSProof,
  publicSignals: string[],
  opts: VerifyOnChainOptions = {}
): Promise<boolean> {
  const { ethers } = await import("ethers");
  const rpc = opts.rpc ?? FLOW_EVM_TESTNET_RPC;
  const address = opts.address ?? VERIFIER_ADDRESS;

  const provider = new ethers.JsonRpcProvider(rpc);
  const abi = [
    "function verifyProof(uint256[2] calldata _pA, uint256[2][2] calldata _pB, uint256[2] calldata _pC, uint256[6] calldata _pubSignals) public view returns (bool)",
  ];
  const verifier = new ethers.Contract(address, abi, provider);

  const { pA, pB, pC } = applyPiBSwap(proof);
  const pub = publicSignals.slice(0, 6).map((s) => BigInt(s));

  return verifier.verifyProof(pA, pB, pC, pub);
}

/**
 * Estimate gas for verifyProof on the deployed contract.
 */
export async function estimateVerifyGas(
  proof: SnarkJSProof,
  publicSignals: string[],
  opts: VerifyOnChainOptions = {}
): Promise<bigint> {
  const { ethers } = await import("ethers");
  const rpc = opts.rpc ?? FLOW_EVM_TESTNET_RPC;
  const address = opts.address ?? VERIFIER_ADDRESS;

  const provider = new ethers.JsonRpcProvider(rpc);
  const abi = [
    "function verifyProof(uint256[2] calldata _pA, uint256[2][2] calldata _pB, uint256[2] calldata _pC, uint256[6] calldata _pubSignals) public view returns (bool)",
  ];
  const verifier = new ethers.Contract(address, abi, provider);

  const { pA, pB, pC } = applyPiBSwap(proof);
  const pub = publicSignals.slice(0, 6).map((s) => BigInt(s));

  return verifier.verifyProof.estimateGas(pA, pB, pC, pub);
}

// ---------------------------------------------------------------------------
// Local verification (no network)
// ---------------------------------------------------------------------------

/**
 * Verify a proof locally using snarkjs (no network).
 * Requires the verification key JSON from the .zkey setup.
 */
export async function verifyLocally(
  vk: object,
  proof: SnarkJSProof,
  publicSignals: string[]
): Promise<boolean> {
  const snarkjs = await import("snarkjs");
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}

// ---------------------------------------------------------------------------
// Proof generation
// ---------------------------------------------------------------------------

export interface ProveOptions {
  wasmPath: string;
  zkeyPath: string;
}

/**
 * Generate a Groth16 proof for any circuit.
 *
 * @param input  Circuit inputs (private + public signals)
 * @param opts   Paths to WASM and .zkey files
 * @returns      Raw snarkJS proof and public signals (decimal strings)
 */
export async function prove(
  input: Record<string, unknown>,
  opts: ProveOptions
): Promise<{ proof: SnarkJSProof; publicSignals: string[] }> {
  const snarkjs = await import("snarkjs");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    opts.wasmPath,
    opts.zkeyPath
  );
  return { proof: proof as SnarkJSProof, publicSignals };
}

/**
 * Generate a proof AND convert to EVM format in one call.
 * Returns both the raw proof (for local verification) and the EVM-ready proof.
 */
export async function proveForEVM(
  input: Record<string, unknown>,
  opts: ProveOptions
): Promise<{
  rawProof: SnarkJSProof;
  evmProof: EVMProof;
  proofUint256: ProofUint256;
  publicSignals: string[];
}> {
  const { proof: rawProof, publicSignals } = await prove(input, opts);
  const evmProof = applyPiBSwap(rawProof);
  const proofUint256 = evmProofToUint256Array(evmProof);
  return { rawProof, evmProof, proofUint256, publicSignals };
}
