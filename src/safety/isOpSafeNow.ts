/**
 * safety/isOpSafeNow.ts
 *
 * Lightweight op-safety probe. Returns whether a given operation type can be
 * safely attempted for a COA + token, and why it is or isn't safe.
 *
 * This is a non-throwing wrapper over assertCheckpointMatchesCommit.
 * Use it to gate UI buttons without showing a hard error.
 */

import { assertCheckpointMatchesCommit, CheckpointDivergenceError } from "./assertCheckpointMatchesCommit";
import type { AssertCheckpointOpts } from "./assertCheckpointMatchesCommit";

export type OpType = "wrap" | "send" | "claim" | "unwrap";

export type SuggestedAction =
  | "ok"               // proceed normally
  | "claim_pending"    // claim pending notes first, then retry
  | "admin_reset_needed" // checkpoint blinding corrupted; admin reset required (testnet)
  | "wait";            // transient error, retry later

export interface OpSafetyResult {
  safe:            boolean;
  reason:          string;
  suggestedAction: SuggestedAction;
  /** Diagnostic details from CheckpointDivergenceError (if applicable). */
  divergenceDiag?: CheckpointDivergenceError["diagnostics"];
}

/**
 * Check whether the given operation is safe to attempt now.
 *
 * @param coa           Sender's EVM address.
 * @param tokenAddress  EVM proxy address of the Janus token.
 * @param opType        The operation the user wants to perform.
 * @param opts          Same opts as assertCheckpointMatchesCommit.
 */
export async function isOpSafeNow(
  coa: string,
  tokenAddress: string,
  opType: OpType,
  opts: AssertCheckpointOpts,
): Promise<OpSafetyResult> {
  // Wrap never needs C_old to match — it only ADDS to the commitment homomorphically.
  // The checkpoint after wrap may not include pending notes, but future claim will.
  if (opType === "wrap") {
    return { safe: true, reason: "wrap does not require C_old match", suggestedAction: "ok" };
  }

  // Claim: the claim flow already accumulates pending notes correctly (BatchClaimCTA fix).
  // The only pre-condition is that the checkpoint blinding itself is not corrupted
  // (i.e., the OLD BatchClaimCTA bug was not triggered previously).
  // We still run the assert — if it fails, a divergence is already present.
  try {
    await assertCheckpointMatchesCommit(coa, tokenAddress, opts);
    return { safe: true, reason: "commitment coherent", suggestedAction: "ok" };
  } catch (err) {
    if (err instanceof CheckpointDivergenceError) {
      const diag = err.diagnostics;

      // Heuristic: if pendingCount > 0 and the delta is exactly the pending sum,
      // the issue MAY just be a stale cursor (newly received notes not yet absorbed).
      // In that case, claiming resolves it.
      // If pendingCount === 0 and there's still a divergence, the blinding is corrupted.
      const isBlindingCorruption = diag.pendingCount === 0;

      if (opType === "claim" && !isBlindingCorruption) {
        // Claim will absorb pending notes and fix the mismatch — safe to proceed.
        return {
          safe:            true,
          reason:          "divergence detected but claim will absorb pending notes and fix it",
          suggestedAction: "claim_pending",
          divergenceDiag:  diag,
        };
      }

      if (isBlindingCorruption) {
        return {
          safe:            false,
          reason:          `Checkpoint blinding is corrupted (pendingCount=0 but commitment mismatch). ` +
                           `Likely caused by an old BatchClaimCTA bug storing accumulated blinding. ` +
                           `Requires adminResetCommitment (testnet) or manual recovery.`,
          suggestedAction: "admin_reset_needed",
          divergenceDiag:  diag,
        };
      }

      // send / unwrap with pending notes: the sendTip cursor fix absorbs them automatically.
      // But the commitment will still pass the check — this shouldn't actually throw here
      // unless there's additional corruption beyond just having pending notes.
      return {
        safe:            false,
        reason:          err.message,
        suggestedAction: diag.pendingCount > 0 ? "claim_pending" : "admin_reset_needed",
        divergenceDiag:  diag,
      };
    }

    // Unknown error — transient
    return {
      safe:            false,
      reason:          err instanceof Error ? err.message : String(err),
      suggestedAction: "wait",
    };
  }
}
