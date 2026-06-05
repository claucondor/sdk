/**
 * orchestration/wrap.ts — Full wrap orchestration: gross→net→proof→encrypt→params.
 *
 * This module owns the COMPLETE ordering of operations for a wrap tx.
 * No adapter or frontend should re-implement this sequence.
 *
 * Sequence:
 *   1. Resolve nonce (from localStorage in browser, parameter in Node).
 *   2. Read feeBps from contract.
 *   3. Compute netAmount = gross - fee.
 *   4. Build AmountDisclose proof for netAmount + fresh blinding + nonce.
 *   5. Encrypt snapshot {netAmount, blinding, timestampMs} to sender's memokey.
 *   6. Return all params ready for the adapter's wrapWithProof call.
 *
 * CRITICAL: The proof MUST bind to netAmount, not grossAmount.
 * Binding to grossAmount causes a silent verification revert.
 *
 * Nonce tracking (per-user, per-token):
 *   Browser: localStorage key "openjanus:wrap-nonce:<addr>:<tokenId>", starts at 1.
 *   Node:    Accept nonce as explicit parameter (tests and automation).
 */

import { buildAmountDiscloseProof } from "../crypto/amount-disclose";
import { encryptSnapshot } from "../crypto/snapshot-schema";
import { generateBlinding } from "../crypto/commitment";
import type { BabyJubKeypair } from "../crypto/babyjub-keypair";
import type { ProofUint256 } from "../types/proof";

// ---------------------------------------------------------------------------
// Nonce helpers
// ---------------------------------------------------------------------------

const NONCE_KEY_PREFIX = "openjanus:wrap-nonce";

/**
 * Read the next nonce for (userAddr, tokenId) from localStorage.
 * Returns 1n if no nonce has been stored yet.
 * Browser-only — throws in Node.js (pass nonce explicitly via orchestrateWrap).
 */
export function readNonce(userAddr: string, tokenId: string): bigint {
  if (typeof localStorage === "undefined") {
    throw new Error(
      "readNonce: localStorage is not available. Pass nonce explicitly via orchestrateWrap({ nonce: ... })."
    );
  }
  const key = `${NONCE_KEY_PREFIX}:${userAddr.toLowerCase()}:${tokenId}`;
  const stored = localStorage.getItem(key);
  return stored ? BigInt(stored) : 1n;
}

/**
 * Advance the stored nonce for (userAddr, tokenId) after a successful wrap.
 * Increments by 1 and persists to localStorage.
 * Browser-only.
 */
export function advanceNonce(userAddr: string, tokenId: string): void {
  if (typeof localStorage === "undefined") return;
  const key = `${NONCE_KEY_PREFIX}:${userAddr.toLowerCase()}:${tokenId}`;
  const current = readNonce(userAddr, tokenId);
  localStorage.setItem(key, (current + 1n).toString());
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WrapOrchestrateInput {
  grossAmount: bigint;
  feeBps: number;
  senderMemoKeypair: BabyJubKeypair;
  /**
   * Anti-replay nonce for this wrap. Required in Node.js.
   * In the browser, omit to auto-read from localStorage (keyed by senderAddr + tokenId).
   */
  nonce?: bigint;
  /** Sender's EVM address — used for localStorage nonce key (browser only). */
  senderAddr?: string;
  /** Token registry key — used for localStorage nonce key (browser only). */
  tokenId?: string;
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

  // 2. Resolve nonce
  let nonce: bigint;
  if (input.nonce !== undefined) {
    nonce = input.nonce;
  } else if (input.senderAddr && input.tokenId) {
    nonce = readNonce(input.senderAddr, input.tokenId);
  } else {
    // Fallback: use timestamp-derived nonce for Node.js callers who don't pass nonce
    nonce = BigInt(Date.now());
  }

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
