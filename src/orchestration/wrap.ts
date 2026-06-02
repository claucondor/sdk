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
  encryptedSnapshot: Uint8Array;
  ephPubkeyX: bigint;
  ephPubkeyY: bigint;
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
    encryptedSnapshot: snapshotEnc.ciphertext,
    ephPubkeyX: snapshotEnc.ephemeralPubkey.x,
    ephPubkeyY: snapshotEnc.ephemeralPubkey.y,
  };
}
