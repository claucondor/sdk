/**
 * orchestration/wrap.ts — Full wrap orchestration: gross→net→proof→encrypt→params.
 *
 * This module owns the COMPLETE ordering of operations for a wrap tx.
 * No adapter or frontend should re-implement this sequence.
 *
 * Sequence:
 *   1. Resolve nonce (random 256-bit if not explicitly provided).
 *   2. Read feeBps from contract.
 *   3. Compute netAmount = gross - fee.
 *   4. Build AmountDisclose proof for netAmount + fresh blinding + nonce.
 *   5. Encrypt snapshot {netAmount, blinding, timestampMs} to sender's memokey.
 *   6. Return all params ready for the adapter's wrapWithProof call.
 *
 * CRITICAL: The proof MUST bind to netAmount, not grossAmount.
 * Binding to grossAmount causes a silent verification revert.
 *
 * Nonce strategy (v0.7.4+):
 *   Random 256-bit nonce generated via @noble/hashes randomBytes.
 *   Collision probability: 1/2^256 (negligible).
 *   No local state (localStorage) needed — works across devices without coordination.
 *   If input.nonce is explicitly provided (tests, replay), it is used as-is.
 */

import { randomBytes } from "@noble/hashes/utils";
import { buildAmountDiscloseProof } from "../crypto/amount-disclose";
import { encryptSnapshot } from "../crypto/snapshot-schema";
import { generateBlinding } from "../crypto/commitment";
import type { BabyJubKeypair } from "../crypto/babyjub-keypair";
import type { ProofUint256 } from "../types/proof";

// ---------------------------------------------------------------------------
// Random nonce helper
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random 256-bit nonce as a bigint.
 * Uses @noble/hashes randomBytes (works in Node.js and browsers).
 * Collision probability: 1/2^256.
 */
export function randomNonce256(): bigint {
  const bytes = randomBytes(32);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WrapOrchestrateInput {
  grossAmount: bigint;
  feeBps: number;
  senderMemoKeypair: BabyJubKeypair;
  /**
   * Anti-replay nonce for this wrap.
   * If omitted, a random 256-bit nonce is generated automatically.
   * Pass explicitly only for deterministic tests or proof replay.
   */
  nonce?: bigint;
}

export interface WrapOrchestrateResult {
  grossAmount: bigint;
  netAmount: bigint;
  fee: bigint;
  nonce: bigint;
  blinding: bigint;
  txCommit: readonly [bigint, bigint];
  /**
   * Amount-disclose proof as uint256[8] (EVM-ready, pi_b Fp2-swapped).
   * Split into pA/pB/pC by the adapter for wrapWithProof ABI.
   */
  amountProof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  /** Amount-disclose public inputs [amount, Cx, Cy, nonce]. */
  amountPublicInputs: readonly [bigint, bigint, bigint, bigint];
  encryptedSnapshot: Uint8Array;
  ephPubkeyX: bigint;
  ephPubkeyY: bigint;
}

/**
 * Input for orchestrateWrapWithPrebuiltProof.
 * Used by browser callers that built the proof via a server-side API route
 * (because buildAmountDiscloseProof requires Node.js wasm/zkey file I/O).
 */
export interface WrapOrchestratePrebuiltInput {
  grossAmount: bigint;
  feeBps: number;
  senderMemoKeypair: BabyJubKeypair;
  /** Pre-built Groth16 proof (uint256[8]) from the server-side route. */
  proof: ProofUint256;
  /** Pedersen commitment (Cx, Cy) from the server-side route. */
  txCommit: readonly [bigint, bigint];
  /** Blinding factor generated client-side and sent to the server-side route. */
  blinding: bigint;
  /** Nonce used in the proof. */
  nonce: bigint;
  /** Public inputs [amount, Cx, Cy, nonce] — 4 signals for aggregate circuit. */
  publicInputs: readonly [bigint, bigint, bigint, bigint];
}

/**
 * Orchestrate a wrap with a pre-built proof (browser-safe path).
 *
 * Skips buildAmountDiscloseProof (Node.js only) and uses the proof + blinding
 * supplied by the caller. Performs only snapshot encryption (pure crypto,
 * browser-safe) and packages all calldata fields.
 */
export async function orchestrateWrapWithPrebuiltProof(
  input: WrapOrchestratePrebuiltInput
): Promise<WrapOrchestrateResult> {
  const { grossAmount, feeBps, senderMemoKeypair, proof, txCommit, blinding, nonce, publicInputs } = input;

  const fee = feeBps === 0 ? 0n : (grossAmount * BigInt(feeBps)) / 10000n;
  const netAmount = grossAmount - fee;

  if (netAmount <= 0n) {
    throw new RangeError(
      `orchestrateWrapWithPrebuiltProof: netAmount ${netAmount} is not positive`
    );
  }

  const nowMs = Date.now();
  const snapshotEnc = await encryptSnapshot(
    { balance: netAmount, blinding, timestampMs: nowMs },
    senderMemoKeypair.pubkey
  );

  return {
    grossAmount,
    netAmount,
    fee,
    nonce,
    blinding,
    txCommit,
    amountProof: proof,
    amountPublicInputs: publicInputs,
    encryptedSnapshot: snapshotEnc.ciphertext,
    ephPubkeyX: snapshotEnc.ephemeralPubkey.x,
    ephPubkeyY: snapshotEnc.ephemeralPubkey.y,
  };
}

/**
 * Orchestrate a wrap: compute net, build proof, encrypt snapshot.
 * All crypto ordering is here — adapters call this, then submit the tx.
 */
export async function orchestrateWrap(
  input: WrapOrchestrateInput
): Promise<WrapOrchestrateResult> {
  const { grossAmount, feeBps, senderMemoKeypair } = input;

  // 1. Fee math
  const fee = feeBps === 0 ? 0n : (grossAmount * BigInt(feeBps)) / 10000n;
  const netAmount = grossAmount - fee;

  if (netAmount <= 0n) {
    throw new RangeError(
      `orchestrateWrap: netAmount ${netAmount} is not positive (grossAmount=${grossAmount}, feeBps=${feeBps})`
    );
  }

  // 2. Resolve nonce — random 256-bit unless caller supplies explicit override
  const nonce: bigint = input.nonce !== undefined ? input.nonce : randomNonce256();

  // 3. Fresh blinding for this wrap
  const blinding = generateBlinding();

  // 4. AmountDisclose proof for NET amount with nonce
  const proofResult = await buildAmountDiscloseProof({ amount: netAmount, blinding, nonce });

  // 5. Encrypt snapshot to sender's own memokey
  const nowMs = Date.now();
  const snapshotEnc = await encryptSnapshot(
    { balance: netAmount, blinding, timestampMs: nowMs },
    senderMemoKeypair.pubkey
  );

  return {
    grossAmount,
    netAmount,
    fee,
    nonce,
    blinding,
    txCommit: proofResult.txCommit,
    amountProof: proofResult.proof,
    amountPublicInputs: proofResult.publicInputs,
    encryptedSnapshot: snapshotEnc.ciphertext,
    ephPubkeyX: snapshotEnc.ephemeralPubkey.x,
    ephPubkeyY: snapshotEnc.ephemeralPubkey.y,
  };
}
