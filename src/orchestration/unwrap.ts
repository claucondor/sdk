/**
 * orchestration/unwrap.ts — Full unwrap orchestration.
 *
 * Sequence:
 *   1. Read feeBps from contract.
 *   2. Build AmountDisclose proof for claimedAmount (the FULL debit from commitment).
 *   3. Build ConfidentialTransfer proof for the residual (new commitment after debit).
 *   4. Encrypt residual snapshot to sender's memokey.
 *   5. Return all params.
 *
 * Fee model:
 *   - claimedAmount is the FULL debit from the commitment.
 *   - netToRecipient = claimedAmount - fee.
 *   - The AmountDisclose proof binds to claimedAmount (full, NOT net).
 *   - The contract sends netToRecipient to the recipient and fee to feeRecipient.
 */

import { buildAmountDiscloseProof } from "../crypto/amount-disclose";
import { buildShieldedTransferProof } from "../crypto/shielded-transfer";
import { encryptSnapshot } from "../crypto/snapshot-schema";
import { generateBlinding } from "../crypto/commitment";
import type { BabyJubKeypair } from "../crypto/babyjub-keypair";

export interface UnwrapOrchestrateInput {
  claimedAmount: bigint;
  feeBps: number;
  currentBalance: bigint;
  currentBlinding: bigint;
  senderMemoKeypair: BabyJubKeypair;
}

export interface UnwrapOrchestrateResult {
  claimedAmount: bigint;
  netToRecipient: bigint;
  fee: bigint;
  txCommit: readonly [bigint, bigint];
  amountProof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  /** Amount-disclose public inputs [claimed_amount, Cx, Cy] — pass to JanusFT.unwrap(). */
  amountPublicInputs: readonly [bigint, bigint, bigint];
  transferPublicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  transferProof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  encryptedSnapshot: Uint8Array;
  ephPubkeyX: bigint;
  ephPubkeyY: bigint;
  // For local state update after tx
  newBalance: bigint;
  newBlinding: bigint;
}

/**
 * Orchestrate an unwrap.
 */
export async function orchestrateUnwrap(
  input: UnwrapOrchestrateInput
): Promise<UnwrapOrchestrateResult> {
  const { claimedAmount, feeBps, currentBalance, currentBlinding, senderMemoKeypair } = input;

  if (claimedAmount <= 0n) {
    throw new RangeError(`orchestrateUnwrap: claimedAmount must be > 0, got ${claimedAmount}`);
  }
  if (claimedAmount > currentBalance) {
    throw new RangeError(
      `orchestrateUnwrap: claimedAmount ${claimedAmount} exceeds balance ${currentBalance}`
    );
  }

  // 1. Fee math
  const fee = feeBps === 0 ? 0n : (claimedAmount * BigInt(feeBps)) / 10000n;
  const netToRecipient = claimedAmount - fee;

  // 2. Fresh blindings
  const transferBlinding = generateBlinding();
  const newBlinding = generateBlinding();

  // 3. AmountDisclose proof for claimedAmount (FULL debit, not net)
  const amountProofResult = await buildAmountDiscloseProof({
    amount: claimedAmount,
    blinding: transferBlinding,
  });

  // 4. ConfidentialTransfer proof for the residual
  const newBalance = currentBalance - claimedAmount;
  const transferProofResult = await buildShieldedTransferProof({
    oldBalance: currentBalance,
    oldBlinding: currentBlinding,
    transferAmount: claimedAmount,
    transferBlinding,
    newBlinding,
  });

  // 5. Encrypt residual snapshot
  const nowMs = Date.now();
  const snapshotEnc = await encryptSnapshot(
    { balance: newBalance, blinding: newBlinding, timestampMs: nowMs },
    senderMemoKeypair.pubkey
  );

  return {
    claimedAmount,
    netToRecipient,
    fee,
    txCommit: amountProofResult.txCommit,
    amountProof: amountProofResult.proof,
    amountPublicInputs: amountProofResult.publicInputs,
    transferPublicInputs: transferProofResult.publicInputs,
    transferProof: transferProofResult.proof,
    encryptedSnapshot: snapshotEnc.ciphertext,
    ephPubkeyX: snapshotEnc.ephemeralPubkey.x,
    ephPubkeyY: snapshotEnc.ephemeralPubkey.y,
    newBalance,
    newBlinding,
  };
}
