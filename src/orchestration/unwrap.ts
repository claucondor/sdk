/**
 * orchestration/unwrap.ts — Full unwrap orchestration.
 *
 * Sequence:
 *   1. Read feeBps from contract.
 *   2. Build AmountDisclose proof for claimedAmount + nonce (the FULL debit).
 *   3. Build ConfidentialTransfer proof for the residual.
 *   4. Encrypt residual snapshot to sender's memokey.
 *   5. Return all params.
 *
 * v0.8.2 checkpoint note:
 *   After the unwrap tx, call ShieldedCheckpoint.update(token, payload, cursor, signer).
 *   `token` = TOKEN_REGISTRY[tokenId].proxy (e.g. JanusFlow proxy for FLOW).
 *   Preferred: use cadenceTx.unwrapFlowAtomic(tokenAddrHex) for atomic single-tx unwrap+checkpoint.
 *
 * WARNING (MockFT path): Cadence ShieldedCheckpoint upgrade was BLOCKED in v0.8.2.
 *   MockFT shielded balance is still subject to singleton overwrite limitation on the
 *   Cadence side. The EVM checkpoint at SHIELDED_CHECKPOINT_ADDRESS works correctly for
 *   all EVM tokens (JanusFlow, JanusERC20). Cadence FT checkpoint fix is deferred.
 *
 * Fee model:
 *   - claimedAmount is the FULL debit from the commitment.
 *   - netToRecipient = claimedAmount - fee.
 *   - The AmountDisclose proof binds to claimedAmount (full, NOT net).
 *   - The contract sends netToRecipient to the recipient and fee to feeRecipient.
 *
 * Nonce for unwrap:
 *   JanusFlow._unwrap always calls _verifyAmountDisclose(..., nonce=0).
 *   The unwrap nonce is NOT a per-user replay counter — it is always 0n.
 *   Passing any value other than 0n will cause the on-chain verifier to reject
 *   the proof (public input mismatch). Do NOT use Date.now() here.
 */

import { buildAmountDiscloseProof } from "../crypto/amount-disclose";
import { buildShieldedTransferProof } from "../crypto/shielded-transfer";
import { encryptSnapshot } from "../crypto/snapshot-schema";
import { generateBlinding } from "../crypto/commitment";
import type { BabyJubKeypair } from "../crypto/babyjub-keypair";
import type { ProofUint256 } from "../types/proof";

export interface UnwrapOrchestrateInput {
  claimedAmount: bigint;
  feeBps: number;
  currentBalance: bigint;
  currentBlinding: bigint;
  senderMemoKeypair: BabyJubKeypair;
  /**
   * Nonce for the unwrap amount-disclose proof.
   *
   * MUST be `0n` (or omitted — defaults to `0n`).
   * JanusFlow._unwrap calls `_verifyAmountDisclose(..., nonce=0)` on-chain.
   * Any non-zero value produces a public-input mismatch and the tx reverts.
   *
   * @default 0n
   */
  nonce?: bigint;
}

export interface UnwrapOrchestrateResult {
  claimedAmount: bigint;
  netToRecipient: bigint;
  fee: bigint;
  nonce: bigint;
  txCommit: readonly [bigint, bigint];
  amountProof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  /** Amount-disclose public inputs [amount, Cx, Cy, nonce] — 4 signals. */
  amountPublicInputs: readonly [bigint, bigint, bigint, bigint];
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
 * Input for orchestrateUnwrapWithPrebuiltProofs.
 * Browser callers POST to /api/proof/unwrap and receive both proofs.
 */
export interface UnwrapOrchestratePrebuiltInput {
  claimedAmount: bigint;
  feeBps: number;
  currentBalance: bigint;
  senderMemoKeypair: BabyJubKeypair;
  /** AmountDisclose proof (uint256[8]) for claimedAmount. */
  amountProof: ProofUint256;
  /** AmountDisclose txCommit [Cx, Cy]. */
  txCommit: readonly [bigint, bigint];
  /** AmountDisclose publicInputs [amount, Cx, Cy, nonce] — 4 signals. */
  amountPublicInputs: readonly [bigint, bigint, bigint, bigint];
  /** ConfidentialTransfer proof (uint256[8]) for the residual spend. */
  transferProof: ProofUint256;
  /** ConfidentialTransfer publicInputs [C_old.x,y, C_tx.x,y, C_new.x,y]. */
  transferPublicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  /** New blinding for the residual commitment (needed for snapshot encryption). */
  newBlinding: bigint;
  /** Nonce used in the amount-disclose proof. */
  nonce: bigint;
}

/**
 * Orchestrate an unwrap with pre-built proofs (browser-safe path).
 */
export async function orchestrateUnwrapWithPrebuiltProofs(
  input: UnwrapOrchestratePrebuiltInput
): Promise<UnwrapOrchestrateResult> {
  const {
    claimedAmount,
    feeBps,
    currentBalance,
    senderMemoKeypair,
    amountProof,
    txCommit,
    amountPublicInputs,
    transferProof,
    transferPublicInputs,
    newBlinding,
    nonce,
  } = input;

  if (claimedAmount <= 0n) {
    throw new RangeError(
      `orchestrateUnwrapWithPrebuiltProofs: claimedAmount must be > 0, got ${claimedAmount}`
    );
  }
  if (claimedAmount > currentBalance) {
    throw new RangeError(
      `orchestrateUnwrapWithPrebuiltProofs: claimedAmount ${claimedAmount} exceeds balance ${currentBalance}`
    );
  }

  const fee = feeBps === 0 ? 0n : (claimedAmount * BigInt(feeBps)) / 10000n;
  const netToRecipient = claimedAmount - fee;
  const newBalance = currentBalance - claimedAmount;

  const snapshotEnc = await encryptSnapshot(
    { balance: newBalance, blinding: newBlinding },
    senderMemoKeypair.pubkey
  );

  return {
    claimedAmount,
    netToRecipient,
    fee,
    nonce,
    txCommit,
    amountProof,
    amountPublicInputs,
    transferPublicInputs,
    transferProof,
    encryptedSnapshot: snapshotEnc.ciphertext,
    ephPubkeyX: snapshotEnc.ephemeralPubkey.x,
    ephPubkeyY: snapshotEnc.ephemeralPubkey.y,
    newBalance,
    newBlinding,
  };
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

  // 2. Resolve nonce
  // Unwrap nonce is always 0n — JanusFlow._unwrap calls _verifyAmountDisclose(..., 0).
  // Any non-zero value causes a public-input mismatch and the verifier reverts.
  const nonce = input.nonce ?? 0n;

  // 3. Fresh blindings
  const transferBlinding = generateBlinding();
  const newBlinding = generateBlinding();

  // 4. AmountDisclose proof for claimedAmount (FULL debit, not net)
  const amountProofResult = await buildAmountDiscloseProof({
    amount: claimedAmount,
    blinding: transferBlinding,
    nonce,
  });

  // 5. ConfidentialTransfer proof for the residual
  const newBalance = currentBalance - claimedAmount;
  const transferProofResult = await buildShieldedTransferProof({
    oldBalance: currentBalance,
    oldBlinding: currentBlinding,
    transferAmount: claimedAmount,
    transferBlinding,
    newBlinding,
  });

  // 6. Encrypt residual snapshot
  const snapshotEnc = await encryptSnapshot(
    { balance: newBalance, blinding: newBlinding },
    senderMemoKeypair.pubkey
  );

  return {
    claimedAmount,
    netToRecipient,
    fee,
    nonce,
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
