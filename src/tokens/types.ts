/**
 * tokens/types.ts — Shared token-level types
 *
 * Types for JanusToken (NATIVE mode) and JanusFlow (WRAPPER mode).
 */

import type { CommitmentXY } from "../types/commitment";
import type { FlowNetwork } from "../network/flow-client";

export type { CommitmentXY, FlowNetwork };

/** Underlying token info — present only in WRAPPER mode instances */
export interface UnderlyingToken {
  /** EVM address of the underlying ERC-20 */
  address: string;
  /** Token symbol (e.g. "FLOW", "USDC") */
  symbol: string;
  /** Token decimals */
  decimals: number;
}

/** Constructor options for token SDK classes */
export interface TokenOptions {
  /** Deployed EVM address of the JanusToken contract */
  evmAddress: string;
  /** Network to connect to */
  network: FlowNetwork;
  /** Present if this instance is in WRAPPER mode */
  underlying?: UnderlyingToken;
}

/** A fully described token deployment (EVM + Cadence sides) */
export interface TokenDeployment {
  /** EVM contract address */
  evm: string;
  /** Cadence account that deployed the Cadence contract */
  cadence: string;
  /** Name of the Cadence contract */
  cadenceContractName: string;
  /** NATIVE = own supply, WRAPPER = wraps an underlying ERC-20 */
  mode: "NATIVE" | "WRAPPER";
  /** Underlying ERC-20 address (WRAPPER mode only) */
  underlying: string | null;
  /** Primitive contract addresses used by this deployment */
  primitives: {
    BabyJub: string;
    Groth16Verifier: string;
    PedersenBabyJub_cdc: string;
  };
}

/** Input for generating a confidential transfer proof (token-level) */
export interface TransferProofInput {
  /** Sender's current balance (uint64) */
  oldBalance: bigint;
  /** Sender's blinding factor at time of wrap/mint */
  oldBlinding: bigint;
  /** Amount to transfer */
  transferAmount: bigint;
  /** Fresh random blinding for the transfer commitment */
  transferBlinding: bigint;
  /** Fresh random blinding for sender's residual commitment */
  newBlinding: bigint;
  /** Path to circuit WASM file */
  wasmPath: string;
  /** Path to proving key (.zkey) file */
  zkeyPath: string;
  /** Path to verification key JSON (optional) */
  vkPath?: string;
}

/** Result of proof generation */
export interface TransferProofResult {
  /** Groth16 proof as uint256[8] (pi_b Fp2-swapped) */
  proof: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  /** Public inputs as uint256[6] */
  publicInputs: [bigint, bigint, bigint, bigint, bigint, bigint];
  /** The three commitment points */
  commitments: {
    oldCommit: CommitmentXY;
    transferCommit: CommitmentXY;
    newCommit: CommitmentXY;
  };
  /** True if the proof was verified locally before submission */
  locallyVerified: boolean;
}
