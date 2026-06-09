/**
 * orchestration/shielded-transfer.ts — Full shielded transfer orchestration.
 *
 * v0.8 design: sender snapshot is NO LONGER passed as calldata to shieldedTransfer.
 * The new 6-arg signature is:
 *   shieldedTransfer(to, publicInputs[6], proof[8], encryptedNoteTo, ephPubkeyToX, ephPubkeyToY)
 *
 * The sender's checkpoint payload (encryptedSnapshot + ephKeys) is returned
 * separately in `checkpointPayload` so callers can:
 *   A. Call ShieldedCheckpoint.update() in a separate EVM tx (two txs)
 *   B. Use combined_shielded_transfer_with_checkpoint.cdc for atomic Cadence execution
 *   C. Skip checkpoint update entirely for read-only testing
 *
 * Sequence:
 *   1. Generate fresh transferBlinding and newBlinding.
 *   2. Build ConfidentialTransfer proof:
 *        private: oldBalance, oldBlinding, transferAmount, transferBlinding, newBlinding
 *        public:  [C_old.x, C_old.y, C_tx.x, C_tx.y, C_new.x, C_new.y]
 *   3. Encrypt recipient note {amount, blinding, memo} to recipient's memokey.
 *   4. Encrypt sender snapshot {balance, blinding} to sender's own memokey.
 *   5. Return:
 *        txParams       — 6 args for shieldedTransfer calldata
 *        checkpointPayload — 3 args for ShieldedCheckpoint.update()
 */

import { buildShieldedTransferProof } from "../crypto/shielded-transfer";
import { encryptSnapshot } from "../crypto/checkpoint-schema";
import { encryptNote } from "../crypto/note-helpers";
import { generateBlinding } from "../crypto/commitment";
import type { BabyJubKeypair } from "../crypto/babyjub-keypair";
import type { Point } from "../types/commitment";
import type { ProofUint256 } from "../types/proof";
import type { CheckpointPayload } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShieldedTransferOrchestrateInput {
  currentBalance: bigint;
  currentBlinding: bigint;
  transferAmount: bigint;
  senderMemoKeypair: BabyJubKeypair;
  recipientMemoKey: Point;
  memo?: string;
}

/**
 * v0.8 result shape: txParams (6 calldata args for shieldedTransfer) +
 * checkpointPayload (3 args for ShieldedCheckpoint.update()).
 *
 * The result also exposes newBalance and newBlinding for local state
 * tracking (the caller should update their in-memory state with these values
 * regardless of whether they update the checkpoint).
 */
export interface ShieldedTransferOrchestrateResult {
  /** Six calldata arguments for the v0.8 shieldedTransfer(to, ...) ABI. */
  txParams: {
    publicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
    proof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    encryptedNoteTo: Uint8Array;
    ephPubkeyToX: bigint;
    ephPubkeyToY: bigint;
  };
  /** Encrypted sender state for ShieldedCheckpoint.update(). */
  checkpointPayload: CheckpointPayload;
  /** Sender's new balance after transfer (for local state update). */
  newBalance: bigint;
  /** Sender's new blinding after transfer (for local state update). */
  newBlinding: bigint;
  /** Transfer blinding (needed if caller wants to reconstruct C_tx locally). */
  transferBlinding: bigint;
}

export interface ShieldedTransferOrchestratePrebuiltInput {
  currentBalance: bigint;
  transferAmount: bigint;
  senderMemoKeypair: BabyJubKeypair;
  recipientMemoKey: Point;
  memo?: string;
  /** Pre-built ConfidentialTransfer proof (uint256[8]). */
  proof: ProofUint256;
  /** Public inputs [C_old.x, C_old.y, C_tx.x, C_tx.y, C_new.x, C_new.y]. */
  publicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  /** Transfer blinding used when computing C_tx (needed for recipient note). */
  transferBlinding: bigint;
  /** New blinding for the residual commitment (needed for checkpoint). */
  newBlinding: bigint;
}

// ---------------------------------------------------------------------------
// Core orchestration
// ---------------------------------------------------------------------------

/**
 * Orchestrate a shielded transfer.
 * Returns txParams (for shieldedTransfer calldata) + checkpointPayload (for ShieldedCheckpoint.update).
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

  // 3. Encrypt note to recipient's memokey
  const noteEnc = await encryptNote(
    { amount: transferAmount, blinding: transferBlinding, memo },
    recipientMemoKey
  );

  // 4. Encrypt sender's residual snapshot to their own memokey
  const snapshotEnc = await encryptSnapshot(
    { balance: newBalance, blinding: newBlinding },
    senderMemoKeypair.pubkey
  );

  return {
    txParams: {
      publicInputs: proofResult.publicInputs,
      proof: proofResult.proof,
      encryptedNoteTo: noteEnc.ciphertext,
      ephPubkeyToX: noteEnc.ephemeralPubkey.x,
      ephPubkeyToY: noteEnc.ephemeralPubkey.y,
    },
    checkpointPayload: {
      encryptedSnapshot: snapshotEnc.ciphertext,
      ephPubkeyX: snapshotEnc.ephemeralPubkey.x,
      ephPubkeyY: snapshotEnc.ephemeralPubkey.y,
    },
    newBalance,
    newBlinding,
    transferBlinding,
  };
}

/**
 * Orchestrate a shielded transfer with a pre-built proof (browser-safe path).
 *
 * Skips buildShieldedTransferProof (Node.js only). Performs only ECIES
 * encryption for the recipient note and sender checkpoint, which is pure crypto
 * and browser-safe. The proof must have been generated server-side.
 */
export async function orchestrateShieldedTransferWithPrebuiltProof(
  input: ShieldedTransferOrchestratePrebuiltInput
): Promise<ShieldedTransferOrchestrateResult> {
  const {
    currentBalance,
    transferAmount,
    senderMemoKeypair,
    recipientMemoKey,
    memo,
    proof,
    publicInputs,
    transferBlinding,
    newBlinding,
  } = input;

  if (transferAmount <= 0n) {
    throw new RangeError(
      `orchestrateShieldedTransferWithPrebuiltProof: transferAmount must be > 0, got ${transferAmount}`
    );
  }
  if (transferAmount > currentBalance) {
    throw new RangeError(
      `orchestrateShieldedTransferWithPrebuiltProof: transferAmount ${transferAmount} exceeds balance ${currentBalance}`
    );
  }

  const newBalance = currentBalance - transferAmount;

  // Encrypt note to recipient (uses its own ephemeral)
  const noteEnc = await encryptNote(
    { amount: transferAmount, blinding: transferBlinding, memo },
    recipientMemoKey
  );

  // Encrypt sender's residual snapshot (uses a different ephemeral)
  const snapshotEnc = await encryptSnapshot(
    { balance: newBalance, blinding: newBlinding },
    senderMemoKeypair.pubkey
  );

  return {
    txParams: {
      publicInputs,
      proof,
      encryptedNoteTo: noteEnc.ciphertext,
      ephPubkeyToX: noteEnc.ephemeralPubkey.x,
      ephPubkeyToY: noteEnc.ephemeralPubkey.y,
    },
    checkpointPayload: {
      encryptedSnapshot: snapshotEnc.ciphertext,
      ephPubkeyX: snapshotEnc.ephemeralPubkey.x,
      ephPubkeyY: snapshotEnc.ephemeralPubkey.y,
    },
    newBalance,
    newBlinding,
    transferBlinding,
  };
}
