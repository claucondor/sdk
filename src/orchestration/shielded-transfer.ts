/**
 * orchestration/shielded-transfer.ts — Full shielded transfer orchestration.
 *
 * Sequence (TWO ephemerals — forward secrecy + recipient note):
 *   1. Read recipient's memokey from contract.
 *   2. Generate fresh blindings: transferBlinding, newBlinding.
 *   3. Build ConfidentialTransfer proof:
 *        private: oldBalance, oldBlinding, transferAmount, transferBlinding, newBlinding
 *        public:  [C_old, C_tx, C_new]
 *   4. Encrypt snapshot (sender's residual {newBalance, newBlinding}) to sender's memokey.
 *      Uses ephemeral A (ephPubkeyX/Y) — snapshot for sender's own recovery.
 *   5. Encrypt note {transferAmount, transferBlinding, memo} to RECIPIENT's memokey.
 *      Uses ephemeral B (ephPubkeyToX/Y) — note for recipient.
 *   6. Return all params.
 *
 * Forward secrecy: each call uses independent fresh ephemerals for both
 * the sender snapshot and the recipient note, so two txs to the same
 * recipient are unlinkable by ephemeral pubkey.
 */

import { buildShieldedTransferProof } from "../crypto/shielded-transfer";
import { encryptSnapshot } from "../crypto/snapshot-schema";
import { encryptNote } from "../crypto/note-schema";
import { generateBlinding } from "../crypto/commitment";
import type { BabyJubKeypair } from "../crypto/babyjub-keypair";
import type { Point } from "../types/commitment";

export interface ShieldedTransferOrchestrateInput {
  currentBalance: bigint;
  currentBlinding: bigint;
  transferAmount: bigint;
  senderMemoKeypair: BabyJubKeypair;
  recipientMemoKey: Point;
  memo?: string;
  tipId?: string;
}

export interface ShieldedTransferOrchestrateResult {
  publicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  proof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  // Sender snapshot (ephemeral A)
  encryptedSnapshot: Uint8Array;
  ephPubkeyX: bigint;
  ephPubkeyY: bigint;
  // Recipient note (ephemeral B)
  encryptedNoteTo: Uint8Array;
  ephPubkeyToX: bigint;
  ephPubkeyToY: bigint;
  // For local state update after tx
  newBalance: bigint;
  newBlinding: bigint;
  transferBlinding: bigint;
}

/**
 * Orchestrate a shielded transfer.
 * Returns all params the adapter needs to call shieldedTransfer(to, ...).
 */
export async function orchestrateShieldedTransfer(
  input: ShieldedTransferOrchestrateInput
): Promise<ShieldedTransferOrchestrateResult> {
  const {
    currentBalance,
    currentBlinding,
    transferAmount,
    senderMemoKeypair,
    recipientMemoKey,
    memo,
    tipId,
  } = input;

  if (transferAmount <= 0n) {
    throw new RangeError(
      `orchestrateShieldedTransfer: transferAmount must be > 0, got ${transferAmount}`
    );
  }
  if (transferAmount > currentBalance) {
    throw new RangeError(
      `orchestrateShieldedTransfer: transferAmount ${transferAmount} exceeds balance ${currentBalance}`
    );
  }

  // 1. Fresh blindings
  const transferBlinding = generateBlinding();
  const newBlinding = generateBlinding();

  // 2. Build ConfidentialTransfer proof
  const proofResult = await buildShieldedTransferProof({
    oldBalance: currentBalance,
    oldBlinding: currentBlinding,
    transferAmount,
    transferBlinding,
    newBlinding,
  });

  const newBalance = currentBalance - transferAmount;
  const nowMs = Date.now();

  // 3. Encrypt sender's residual snapshot to their own memokey (ephemeral A)
  const snapshotEnc = await encryptSnapshot(
    { balance: newBalance, blinding: newBlinding, timestampMs: nowMs },
    senderMemoKeypair.pubkey
  );

  // 4. Encrypt note to recipient's memokey (ephemeral B — different ephemeral)
  const noteEnc = await encryptNote(
    { amount: transferAmount, blinding: transferBlinding, memo, tipId },
    recipientMemoKey
  );

  return {
    publicInputs: proofResult.publicInputs,
    proof: proofResult.proof,
    encryptedSnapshot: snapshotEnc.ciphertext,
    ephPubkeyX: snapshotEnc.ephemeralPubkey.x,
    ephPubkeyY: snapshotEnc.ephemeralPubkey.y,
    encryptedNoteTo: noteEnc.ciphertext,
    ephPubkeyToX: noteEnc.ephemeralPubkey.x,
    ephPubkeyToY: noteEnc.ephemeralPubkey.y,
    newBalance,
    newBlinding,
    transferBlinding,
  };
}
