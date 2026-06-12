/**
 * utils/fresh-slot.ts — Helpers for fresh/reset commitment slots.
 *
 * W1: isFreshSlotCommit — detects the identity point that signals admin reset
 * W5: computeActualCOld — accumulates pending note deltas for correct C_old in claim proofs
 *
 * Both were promoted from private-tip-v1/web components and tip-actions.ts
 * after the claim-revert diagnosis (/tmp/claim_revert_diagnosis.md) and
 * phantom-note diagnosis (/tmp/musdc_phantom_diagnosis.md) revealed that
 * every app re-discovers these patterns independently.
 *
 * @module @claucondor/sdk/utils
 */

import { SUBORDER } from "@openjanus/commitment";

// Re-export so callers don't need to import from @openjanus/commitment directly
export { SUBORDER as BABYJUB_SUBORDER };

/**
 * Check whether a Pedersen commitment point is the BabyJubJub identity point.
 *
 * The identity point `(x=0, y=1)` is the additive neutral element of the
 * BabyJubJub group. On-chain commitment slots start at the identity after:
 *   - Account first creation (before any wrap)
 *   - Admin reset via `adminResetSlot()` on JanusFlow/JanusERC20
 *   - Admin reset via `adminBatchResetSlots()` on JanusFT
 *
 * When `isFreshSlotCommit` returns true the caller MUST treat the previous
 * balance, blinding, and cursor as zero — using a stale local checkpoint
 * while the on-chain slot is zeroed will produce a C_old mismatch and the
 * verifier will reject the transaction.
 *
 * @param commit  Commitment point from `adapter.getCommitment(addr)`.
 * @returns       true if the slot is uninitialized/reset; false if it holds real state.
 *
 * @example
 *   const commit = await adapter.getCommitment(cadenceAddr);
 *   if (isFreshSlotCommit(commit)) {
 *     prevBalance = 0n;
 *     prevBlinding = 0n;
 *     prevCursor = 0n;
 *   }
 */
export function isFreshSlotCommit(commit: { x: bigint; y: bigint }): boolean {
  return commit.x === 0n && commit.y === 1n;
}

/**
 * Compute the actual C_old (balance + blinding) needed as proof input for a
 * claimBatch or unwrap after pending inbox notes have updated the on-chain
 * commitment homomorphically.
 *
 * PROBLEM: When a sender calls `shieldedTransfer` to a recipient, the EVM contract
 * updates the recipient's on-chain commitment homomorphically BEFORE the recipient
 * claims. The ShieldedCheckpoint stores the last-written (stale) balance+blinding.
 * The circuit's C_old must equal the CURRENT on-chain commitment, which is:
 *   current_commit = checkpoint_commit + Σ(note_commits)
 *
 * In scalar terms:
 *   actualOldBalance  = checkpointBalance + Σ(note.amount)
 *   actualOldBlinding = (checkpointBlinding + Σ(note.blinding)) mod SUBORDER
 *
 * Then pass ZERO notes to the circuit (re-blinding only): the note amounts are
 * already baked into actualOldBalance. `newBalance = actualOldBalance`.
 *
 * This was the root cause of the claim revert documented in
 * /tmp/claim_revert_diagnosis.md — the front was passing checkpoint.balance
 * as C_old while the on-chain commitment was already advanced by pending tips.
 *
 * @param checkpoint    Last-written ShieldedCheckpoint snapshot (balance + blinding).
 * @param pendingNotes  Inbox notes that arrived AFTER the last checkpoint write.
 *                      Each note must include the decrypted amount and blinding.
 * @returns             { balance, blinding } to use as C_old in the circuit input.
 *
 * @example
 *   const { balance: cOldBal, blinding: cOldBli } = computeActualCOld(
 *     { balance: checkpoint.balance, blinding: checkpoint.blinding },
 *     portfolio.tokens.flow.pendingNotes,  // from getPortfolioView
 *   );
 *   const proof = await buildBatchClaimProof({
 *     oldBalance: cOldBal, oldBlinding: cOldBli, newBlinding, notes: zeroNotes,
 *   });
 */
export function computeActualCOld(
  checkpoint: { balance: bigint; blinding: bigint },
  pendingNotes: ReadonlyArray<{ amount: bigint; blinding: bigint }>,
): { balance: bigint; blinding: bigint } {
  let balance = checkpoint.balance;
  let blinding = checkpoint.blinding;

  for (const note of pendingNotes) {
    balance = balance + note.amount;
    blinding = (blinding + note.blinding) % SUBORDER;
  }

  return { balance, blinding };
}
