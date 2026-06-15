/**
 * safety/safeBuildProofs.ts
 *
 * Safe wrappers that run assertCheckpointMatchesCommit before delegating to the
 * actual proof-build / tx-submit logic. Callers get a structured error if the
 * commitment state is already incoherent, rather than wasting gas on a proof
 * that will revert on-chain.
 *
 * These wrappers are intentionally thin — they do NOT re-implement the proof
 * logic. They assert, then re-throw with context on failure.
 *
 * Usage pattern:
 *   await safeBuildSendProof({ coa, tokenAddress, memoPrivkey, janusTokenAddr, ... });
 *   // now safe to call the actual send
 */

import { assertCheckpointMatchesCommit, CheckpointDivergenceError } from "./assertCheckpointMatchesCommit";
import type { AssertCheckpointOpts } from "./assertCheckpointMatchesCommit";

export interface SafeProofOpts extends AssertCheckpointOpts {
  /** Sender's EVM address. */
  coa:          string;
  /** EVM token proxy address. */
  tokenAddress: string;
}

async function runAssert(opts: SafeProofOpts, opLabel: string): Promise<void> {
  try {
    await assertCheckpointMatchesCommit(opts.coa, opts.tokenAddress, opts);
  } catch (err) {
    if (err instanceof CheckpointDivergenceError) {
      throw new Error(
        `[${opLabel}] Pre-flight failed: ${err.message}\n` +
        `Diagnostics: pendingCount=${err.diagnostics.pendingCount} ` +
        `cpBalance=${err.diagnostics.cpBalance} ` +
        `sumPending=${err.diagnostics.sumPendingAmts}`,
      );
    }
    throw err;
  }
}

/**
 * Assert coherence before wrap.
 *
 * Note: wrap only ADDS to the commitment — it does NOT require C_old to match.
 * This function is provided for symmetry but always resolves immediately.
 */
export async function safeBuildWrapProof(opts: SafeProofOpts): Promise<void> {
  // Wrap does not consume C_old; no sanity check needed.
  void opts;
}

/**
 * Assert coherence before send.
 * sendTip / sendTipAtomic will absorb pending notes automatically (cursor fix),
 * so this checks a weaker invariant: the blinding itself is not corrupted.
 */
export async function safeBuildSendProof(opts: SafeProofOpts): Promise<void> {
  await runAssert(opts, "safeBuildSendProof");
}

/**
 * Assert coherence before claim.
 * The claim flow (BatchClaimCTA) correctly accumulates pending notes, so even a
 * divergence caused by pending-but-not-yet-consumed notes is OK here.
 * We still guard against blinding corruption (pendingCount=0 divergence).
 *
 * cadence-ft (MockFT) exception: commitments for Cadence FT tokens live in the
 * Cadence JanusFT contract, not in any EVM JanusToken mapping. The tokenAddress
 * passed for cadence-ft is the Cadence deployer address zero-padded to 20 bytes
 * (e.g. 0x000000000000000000000000<8-byte-cadence-addr>). Calling
 * JanusToken.commitments() on that padded address returns (0,0), which produces
 * a false divergence. Skip the EVM pre-flight entirely for these tokens — the
 * claimBatchFtAtomic path has its own Cadence-side guards.
 *
 * Detection: legitimate EVM contract addresses never start with 12 leading zero
 * bytes (P(collision) ≈ 10^-29). Cadence 8-byte addresses always do when
 * zero-padded to EVM 20-byte format.
 */
export async function safeBuildClaimProof(opts: SafeProofOpts): Promise<void> {
  // cadence-ft: Cadence address zero-padded to EVM format → no EVM commitment to check.
  if (opts.tokenAddress.toLowerCase().startsWith("0x000000000000000000000000")) {
    return;
  }
  await runAssert(opts, "safeBuildClaimProof");
}

/**
 * Assert coherence before unwrap.
 * unwrap consumes C_old exactly like send; same requirement.
 */
export async function safeBuildUnwrapProof(opts: SafeProofOpts): Promise<void> {
  await runAssert(opts, "safeBuildUnwrapProof");
}
