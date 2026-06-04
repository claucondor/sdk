/**
 * orchestration/wrap.ts — Full wrap orchestration: gross→net→proof→encrypt→params.
 *
 * This module owns the COMPLETE ordering of operations for a wrap tx.
 * No adapter or frontend should re-implement this sequence.
 *
 * Sequence:
 *   1. Read feeBps from contract.
 *   2. Compute netAmount = computeNetWrap(grossAmount, feeBps).
 *   3. Build AmountDisclose proof for netAmount + fresh blinding.
 *   4. Encrypt snapshot {netAmount, blinding, timestampMs} to sender's memokey.
 *   5. Return all params ready for the adapter to submit.
 *
 * CRITICAL: The proof MUST bind to netAmount, not grossAmount.
 * Binding to grossAmount causes a silent verification revert.
 */

import { buildAmountDiscloseProof } from "../crypto/amount-disclose";
import { encryptSnapshot } from "../crypto/snapshot-schema";
import { generateBlinding } from "../crypto/commitment";
import type { BabyJubKeypair } from "../crypto/babyjub-keypair";
import type { ProofUint256 } from "../types/proof";

export interface WrapOrchestrateInput {
  grossAmount: bigint;
  feeBps: number;
  senderMemoKeypair: BabyJubKeypair;
}

export interface WrapOrchestrateResult {
  grossAmount: bigint;
  netAmount: bigint;
  fee: bigint;
  blinding: bigint;
  txCommit: readonly [bigint, bigint];
  amountProof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  /** Amount-disclose public inputs [claimed_amount, Cx, Cy] — pass to JanusFT.wrap(). */
  amountPublicInputs: readonly [bigint, bigint, bigint];
  encryptedSnapshot: Uint8Array;
  ephPubkeyX: bigint;
  ephPubkeyY: bigint;
}

/**
 * Input for orchestrateWrapWithPrebuiltProof.
 * Used by browser callers that built the proof via a server-side API route
 * (because buildAmountDiscloseProof requires Node.js wasm/zkey file I/O).
 *
 * The browser generates blinding + calls POST /api/proof/wrap, which returns
 * proof + txCommit. The browser then passes everything here for snapshot
 * encryption and calldata assembly.
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
  /** Public inputs [claimed_amount, Cx, Cy] — needed for amountPublicInputs. */
  publicInputs: readonly [bigint, bigint, bigint];
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
  const { grossAmount, feeBps, senderMemoKeypair, proof, txCommit, blinding, publicInputs } = input;

  const fee = feeBps === 0 ? 0n : (grossAmount * BigInt(feeBps)) / 10000n;
  const netAmount = grossAmount - fee;

  if (netAmount <= 0n) {
    throw new RangeError(
      `orchestrateWrapWithPrebuiltProof: netAmount ${netAmount} is not positive`
    );
  }

  // Encrypt snapshot to sender's own memokey (same as regular path).
  const nowMs = Date.now();
  const snapshotEnc = await encryptSnapshot(
    { balance: netAmount, blinding, timestampMs: nowMs },
    senderMemoKeypair.pubkey
  );

  return {
    grossAmount,
    netAmount,
    fee,
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

  // 2. Fresh blinding for this wrap
  const blinding = generateBlinding();

  // 3. AmountDisclose proof for NET amount
  const proofResult = await buildAmountDiscloseProof({ amount: netAmount, blinding });

  // 4. Encrypt snapshot to sender's own memokey (they can decrypt later)
  const nowMs = Date.now();
  const snapshotEnc = await encryptSnapshot(
    { balance: netAmount, blinding, timestampMs: nowMs },
    senderMemoKeypair.pubkey
  );

  return {
    grossAmount,
    netAmount,
    fee,
    blinding,
    txCommit: proofResult.txCommit,
    amountProof: proofResult.proof,
    amountPublicInputs: proofResult.publicInputs,
    encryptedSnapshot: snapshotEnc.ciphertext,
    ephPubkeyX: snapshotEnc.ephemeralPubkey.x,
    ephPubkeyY: snapshotEnc.ephemeralPubkey.y,
  };
}
