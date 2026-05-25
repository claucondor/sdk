/**
 * tokens/types.ts — V2-specific types for ElGamal-based JanusToken/JanusFlow
 *
 * V2 uses additive ElGamal-on-BabyJubJub instead of Pedersen commitments.
 * Each balance slot stores an ElGamal ciphertext (C1, C2) = (r*G, M + r*PK),
 * where M = m*G (value encoded as curve point) and PK is the recipient's pubkey.
 *
 * Multiple senders can encrypt to the same pubkey and deposits accumulate
 * homomorphically: (C1_acc, C2_acc) += (C1_new, C2_new) point-wise.
 * The slot owner decrypts by computing M = C2 - sk*C1, then solves DLOG via BSGS.
 */

import type { Point } from "../types/commitment";
import type { FlowNetwork } from "../network/flow-client";

export type { Point, FlowNetwork };

// ---------------------------------------------------------------------------
// Core ElGamal types
// ---------------------------------------------------------------------------

/**
 * An ElGamal ciphertext on BabyJubJub:
 *   c1 = r * G  (ephemeral public key)
 *   c2 = m * G + r * PK  (masked message point)
 */
export interface Ciphertext {
  c1: Point;
  c2: Point;
}

/**
 * A single ElGamal-encrypted balance slot.
 * This is what is stored per-address in JanusToken.
 */
export interface EncryptedSlot {
  /** Accumulated ciphertext (sum of all received encryptions) */
  ciphertext: Ciphertext;
  /** The pubkey this slot is locked to (recipient's BabyJubJub public key) */
  pubkey: Point;
}

/**
 * A decrypted balance result.
 */
export interface DecryptedBalance {
  /** Recovered plaintext amount */
  amount: bigint;
  /** The slot that was decrypted */
  slot: EncryptedSlot;
}

/**
 * A BabyJubJub keypair for ElGamal.
 * sk — private key (scalar in [1, r))
 * pk — public key = sk * G
 */
export interface ElGamalKeypair {
  sk: bigint;
  pk: Point;
}

// ---------------------------------------------------------------------------
// V2 deployment configuration
// ---------------------------------------------------------------------------

/** Constructor options for V2 token classes */
export interface TokenV2Options {
  /** Deployed EVM address of JanusToken */
  evmAddress: string;
  /** Network to connect to */
  network: FlowNetwork;
  /** Address of the BabyJub.sol helper contract */
  babyJubAddress?: string;
  /** Address of the EncryptConsistencyVerifier */
  encryptVerifierAddress?: string;
  /** Address of the DecryptOpenVerifier */
  decryptVerifierAddress?: string;
}

/** A fully described V2 token deployment */
export interface TokenV2Deployment {
  /** JanusToken EVM address */
  evm: string;
  /** JanusFlow Cadence account */
  cadence: string;
  /** Cadence contract name */
  cadenceContractName: string;
  /** ZK verifier addresses */
  verifiers: {
    EncryptConsistency: string;
    DecryptOpen: string;
  };
  /** BabyJub helper address */
  babyJub: string;
}

// ---------------------------------------------------------------------------
// V2 proof types
// ---------------------------------------------------------------------------

/**
 * Input for generating an encrypt-consistency proof.
 * Proves that an ElGamal ciphertext encrypts a known value m to a known pubkey PK.
 */
export interface EncryptProofInput {
  /** Plaintext amount to encrypt */
  amount: bigint;
  /** Ephemeral randomness r (keep private) */
  randomness: bigint;
  /** Recipient's BabyJubJub public key */
  recipientPubkey: Point;
  /** Path to circuit WASM */
  wasmPath: string;
  /** Path to proving key (.zkey) */
  zkeyPath: string;
  /** Path to verification key JSON (optional) */
  vkPath?: string;
}

/**
 * Input for generating a decrypt-open proof.
 * Proves knowledge of sk such that C1*sk = C2 - m*G (decryption is correct).
 */
export interface DecryptProofInput {
  /** Accumulated ciphertext to decrypt */
  ciphertext: Ciphertext;
  /** Caller's secret key */
  secretKey: bigint;
  /** Recovered plaintext amount */
  amount: bigint;
  /** Path to circuit WASM */
  wasmPath: string;
  /** Path to proving key (.zkey) */
  zkeyPath: string;
  /** Path to verification key JSON (optional) */
  vkPath?: string;
}

/** Result of an encrypt proof */
export interface EncryptProofResult {
  /** Groth16 proof as uint256[8] (pi_b Fp2-swapped) */
  proof: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  /** Public inputs: [c1x, c1y, c2x, c2y, pkx, pky] */
  publicInputs: [bigint, bigint, bigint, bigint, bigint, bigint];
  /** The resulting ciphertext */
  ciphertext: Ciphertext;
  /** True if the proof was verified locally before submission */
  locallyVerified: boolean;
}

/** Result of a decrypt proof */
export interface DecryptProofResult {
  /** Groth16 proof as uint256[8] (pi_b Fp2-swapped) */
  proof: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  /** Public inputs: [c1x, c1y, c2x, c2y, amount] */
  publicInputs: [bigint, bigint, bigint, bigint, bigint];
  /** Decrypted plaintext amount */
  amount: bigint;
  /** True if the proof was verified locally before submission */
  locallyVerified: boolean;
}
