/**
 * crypto/elgamal-proofs.ts — Groth16 proof builders for ElGamal encrypt/decrypt circuits
 *
 * Wraps snarkjs.groth16.fullProve with circuit artifact resolution and EIP-197 pi_b swap.
 * Reference pattern: @zk-kit/groth16
 *
 * Circuit signal ordering (from circom source):
 *
 *   encrypt_consistency — private: value, randomness
 *                          public: recipient_pubkey[2], C1[2], C2[2]
 *                          publicSignals order: [pk.x, pk.y, C1.x, C1.y, C2.x, C2.y]
 *
 *   decrypt_open        — private: privkey
 *                          public: pubkey[2], C1[2], C2[2], claimed_value
 *                          publicSignals order: [pk.x, pk.y, C1.x, C1.y, C2.x, C2.y, value]
 *
 * Trusted setup (v0.2.0):
 *   Phase 1: Hermez ceremony (200+ contributors, pot14)
 *   Beacon:  Flow testnet block 323555648
 *   SHA256 encrypt zkey: 17ab9353f2966336bbf380549a47721ccce4283f20000380e18ecab763c3da16
 *   SHA256 decrypt zkey: d87eda3b96f2eeab11f33583369519d041d25915cdbd49cedf41fd269b8e0745
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { applyPiBSwap, evmProofToUint256Array } from "../utils/pi-b-swap.js";
import type { Point } from "../types/commitment.js";
import type { SnarkJSProof, ProofUint256 } from "../types/proof.js";

// ---------------------------------------------------------------------------
// Circuit artifact paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// dist/crypto/ → go up two levels → package root
// src/crypto/  → go up two levels → package root (same during development)
const PACKAGE_ROOT = resolve(__dirname, "..", "..");

const ENCRYPT_WASM = resolve(PACKAGE_ROOT, "circuits/build/encrypt_consistency.wasm");
const ENCRYPT_ZKEY = resolve(PACKAGE_ROOT, "circuits/setup/encrypt_consistency_final.zkey");
const DECRYPT_WASM = resolve(PACKAGE_ROOT, "circuits/build/decrypt_open.wasm");
const DECRYPT_ZKEY = resolve(PACKAGE_ROOT, "circuits/setup/decrypt_open_final.zkey");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** An ElGamal ciphertext using uppercase convention matching circuit signal names */
export interface ElGamalCiphertext {
  C1: Point;
  C2: Point;
}

/** Input for generating an encrypt-consistency proof */
export interface EncryptProofInput {
  /** Plaintext amount in [0, 2^48) */
  value: bigint;
  /** Ephemeral randomness r — must be cryptographically random, never reuse */
  randomness: bigint;
  /** Recipient's BabyJubJub public key (must be on-curve) */
  recipientPubkey: Point;
}

/** Result of buildEncryptProof */
export interface EncryptProofResult {
  /** The resulting ElGamal ciphertext (C1 = r*G, C2 = value*G + r*PK) */
  ciphertext: ElGamalCiphertext;
  /**
   * Groth16 proof as uint256[8] (pi_b Fp2-swapped for EIP-197).
   * Pass directly to JanusToken.encryptTo() or JanusToken.confidentialTransfer().
   */
  proof: ProofUint256;
  /**
   * Public inputs as bigint[6]: [pk.x, pk.y, C1.x, C1.y, C2.x, C2.y]
   * Pass directly to on-chain verifier.
   */
  publicInputs: [bigint, bigint, bigint, bigint, bigint, bigint];
  /** Raw snarkJS proof object (for off-chain verification via groth16.verify) */
  rawProof: SnarkJSProof;
  /** Raw public signals as decimal strings (as returned by snarkjs) */
  rawPublicSignals: string[];
}

/** Input for generating a decrypt-open proof */
export interface DecryptProofInput {
  /** Accumulated ElGamal ciphertext to decrypt */
  ciphertext: ElGamalCiphertext;
  /** Recipient's BabyJubJub secret key */
  secretKey: bigint;
  /**
   * Recipient's BabyJubJub public key (must match secretKey * G).
   * Derived externally by the caller using babyjub.mulPointEscalar(BASE8, sk).
   * The circuit enforces pubkey == secretKey * G; mismatches fail witness generation.
   */
  pubkey: Point;
  /** Claimed plaintext total — must satisfy decryption equation or witness fails */
  amount: bigint;
}

/** Result of buildDecryptProof */
export interface DecryptProofResult {
  /**
   * Groth16 proof as uint256[8] (pi_b Fp2-swapped for EIP-197).
   * Pass directly to JanusToken.decryptAndUnwrap().
   */
  proof: ProofUint256;
  /**
   * Public inputs as bigint[7]: [pk.x, pk.y, C1.x, C1.y, C2.x, C2.y, claimed_value]
   * Pass directly to on-chain verifier.
   */
  publicInputs: [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  /** The decrypted plaintext amount (mirrors input.amount) */
  amount: bigint;
  /** Raw snarkJS proof object (for off-chain verification via groth16.verify) */
  rawProof: SnarkJSProof;
  /** Raw public signals as decimal strings */
  rawPublicSignals: string[];
}

/** Optional artifact path overrides (for testing or custom deployments) */
export interface ProofArtifactOptions {
  /** Override path to circuit WASM file */
  wasmPath?: string;
  /** Override path to proving key (.zkey) file */
  zkeyPath?: string;
}

// ---------------------------------------------------------------------------
// buildEncryptProof
// ---------------------------------------------------------------------------

/**
 * Generate a Groth16 proof of valid ElGamal encryption.
 *
 * Proves that ciphertext (C1, C2) correctly encrypts `value` to `recipientPubkey`
 * with ephemeral randomness `randomness`:
 *   C1 = randomness * G
 *   C2 = value * G + randomness * recipientPubkey
 *
 * The proof is EVM-ready (pi_b Fp2-swapped per EIP-197) and can be passed
 * directly to JanusToken.encryptTo() or JanusToken.confidentialTransfer().
 *
 * C1 and C2 are derived by the circuit witness solver from the private inputs —
 * they appear as public signals in the output and are returned in `ciphertext`.
 *
 * @param input    Encrypt proof parameters (value, randomness, recipientPubkey)
 * @param options  Optional WASM/zkey path overrides
 * @returns        Ciphertext + EVM-ready proof + public inputs
 */
export async function buildEncryptProof(
  input: EncryptProofInput,
  options?: ProofArtifactOptions
): Promise<EncryptProofResult> {
  const wasmPath = options?.wasmPath ?? ENCRYPT_WASM;
  const zkeyPath = options?.zkeyPath ?? ENCRYPT_ZKEY;

  const snarkjs = await import("snarkjs");

  // Circuit signal names (encrypt_consistency.circom):
  //   private inputs: value, randomness
  //   public inputs:  recipient_pubkey[2], C1[2], C2[2]
  //
  // All signals (private + public) must be provided to fullProve.
  // C1 = randomness * G  and  C2 = value * G + randomness * PK
  // We pre-compute these using circomlibjs so we can supply all inputs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { buildBabyjub } = await import("circomlibjs") as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const babyjub: any = await buildBabyjub();
  const F = babyjub.F;

  // BASE8 = the BabyJubJub generator point used by circomlib (8 * G)
  const BASE8 = babyjub.Base8;

  // Compute C1 = randomness * BASE8
  // mulPointEscalar accepts bigint scalar directly via ffjavascript Scalar
  const c1Point = babyjub.mulPointEscalar(BASE8, input.randomness);
  const c1x = F.toObject(c1Point[0]) as bigint;
  const c1y = F.toObject(c1Point[1]) as bigint;

  // Compute value * BASE8 = value encoding on curve
  const vgPoint = babyjub.mulPointEscalar(BASE8, input.value);

  // Compute r * PK — PK supplied as field elements
  const pkPoint = [F.e(input.recipientPubkey.x), F.e(input.recipientPubkey.y)];
  const rPKPoint = babyjub.mulPointEscalar(pkPoint, input.randomness);

  // C2 = vG + rPK
  const c2Point = babyjub.addPoint(vgPoint, rPKPoint);
  const c2x = F.toObject(c2Point[0]) as bigint;
  const c2y = F.toObject(c2Point[1]) as bigint;

  const circuitInput = {
    value: input.value.toString(),
    randomness: input.randomness.toString(),
    recipient_pubkey: [
      input.recipientPubkey.x.toString(),
      input.recipientPubkey.y.toString(),
    ],
    C1: [c1x.toString(), c1y.toString()],
    C2: [c2x.toString(), c2y.toString()],
  };

  const { proof, publicSignals } = (await snarkjs.groth16.fullProve(
    circuitInput,
    wasmPath,
    zkeyPath
  )) as { proof: SnarkJSProof; publicSignals: string[] };

  // publicSignals ordering (circom public declaration order):
  //   [0] recipient_pubkey[0] = pk.x
  //   [1] recipient_pubkey[1] = pk.y
  //   [2] C1[0] = C1.x
  //   [3] C1[1] = C1.y
  //   [4] C2[0] = C2.x
  //   [5] C2[1] = C2.y
  if (publicSignals.length !== 6) {
    throw new Error(
      `buildEncryptProof: expected 6 public signals, got ${publicSignals.length}`
    );
  }

  const evmProof = applyPiBSwap(proof);
  const proofUint256 = evmProofToUint256Array(evmProof);

  const pubInputs: [bigint, bigint, bigint, bigint, bigint, bigint] = [
    BigInt(publicSignals[0]),
    BigInt(publicSignals[1]),
    BigInt(publicSignals[2]),
    BigInt(publicSignals[3]),
    BigInt(publicSignals[4]),
    BigInt(publicSignals[5]),
  ];

  return {
    ciphertext: {
      C1: { x: BigInt(publicSignals[2]), y: BigInt(publicSignals[3]) },
      C2: { x: BigInt(publicSignals[4]), y: BigInt(publicSignals[5]) },
    },
    proof: proofUint256,
    publicInputs: pubInputs,
    rawProof: proof,
    rawPublicSignals: publicSignals,
  };
}

// ---------------------------------------------------------------------------
// buildDecryptProof
// ---------------------------------------------------------------------------

/**
 * Generate a Groth16 proof of valid ElGamal decryption.
 *
 * Proves that the holder of `secretKey` can correctly open the accumulated
 * ciphertext to `amount`:
 *   pubkey = secretKey * G       (key ownership)
 *   skC1   = secretKey * C1      (ElGamal shared secret)
 *   amount * G = C2 - skC1       (correct decryption)
 *   amount in [0, 2^48)          (range check)
 *
 * The proof is EVM-ready (pi_b Fp2-swapped per EIP-197) and can be passed
 * directly to JanusToken.decryptAndUnwrap().
 *
 * IMPORTANT: If `amount` does not satisfy the decryption equation, snarkjs
 * throws during witness generation (not a silent failure).
 *
 * @param input    Decrypt proof parameters (ciphertext, secretKey, pubkey, amount)
 * @param options  Optional WASM/zkey path overrides
 * @returns        EVM-ready proof + public inputs
 */
export async function buildDecryptProof(
  input: DecryptProofInput,
  options?: ProofArtifactOptions
): Promise<DecryptProofResult> {
  const wasmPath = options?.wasmPath ?? DECRYPT_WASM;
  const zkeyPath = options?.zkeyPath ?? DECRYPT_ZKEY;

  const snarkjs = await import("snarkjs");

  // Circuit signal names (decrypt_open.circom):
  //   private inputs: privkey
  //   public inputs:  pubkey[2], C1[2], C2[2], claimed_value
  //
  // All public inputs are supplied by the caller.
  // The circuit enforces pubkey == privkey * G via constraints.
  const circuitInput = {
    privkey: input.secretKey.toString(),
    pubkey: [input.pubkey.x.toString(), input.pubkey.y.toString()],
    C1: [input.ciphertext.C1.x.toString(), input.ciphertext.C1.y.toString()],
    C2: [input.ciphertext.C2.x.toString(), input.ciphertext.C2.y.toString()],
    claimed_value: input.amount.toString(),
  };

  const { proof, publicSignals } = (await snarkjs.groth16.fullProve(
    circuitInput,
    wasmPath,
    zkeyPath
  )) as { proof: SnarkJSProof; publicSignals: string[] };

  // publicSignals ordering (circom public declaration order):
  //   [0] pubkey[0] = pk.x
  //   [1] pubkey[1] = pk.y
  //   [2] C1[0] = C1.x
  //   [3] C1[1] = C1.y
  //   [4] C2[0] = C2.x
  //   [5] C2[1] = C2.y
  //   [6] claimed_value = amount
  if (publicSignals.length !== 7) {
    throw new Error(
      `buildDecryptProof: expected 7 public signals, got ${publicSignals.length}`
    );
  }

  const evmProof = applyPiBSwap(proof);
  const proofUint256 = evmProofToUint256Array(evmProof);

  const pubInputs: [bigint, bigint, bigint, bigint, bigint, bigint, bigint] = [
    BigInt(publicSignals[0]),
    BigInt(publicSignals[1]),
    BigInt(publicSignals[2]),
    BigInt(publicSignals[3]),
    BigInt(publicSignals[4]),
    BigInt(publicSignals[5]),
    BigInt(publicSignals[6]),
  ];

  return {
    proof: proofUint256,
    publicInputs: pubInputs,
    amount: input.amount,
    rawProof: proof,
    rawPublicSignals: publicSignals,
  };
}
