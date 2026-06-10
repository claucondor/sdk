/**
 * proof/batch-claim.ts — buildBatchClaimProof
 *
 * Generates a Groth16 proof for the ConfidentialClaimBatch circuit (N=50 notes).
 *
 * Circuit proves:
 *   C_new = C_old + C_consumed   (on BabyJubJub)
 *   C_old = Commit(oldBalance, oldBlinding)
 *   C_new = Commit(oldBalance + Σ amounts[i], newBlinding)
 *   C_consumed = Σ Commit(amounts[i], blindings[i])   (chained babyAdd, NOT scalar sum)
 *
 * Public input layout (6 signals — matches JanusToken.claimBatch / JanusFT.claimBatch):
 *   [0] C_old_x   [1] C_old_y
 *   [2] C_new_x   [3] C_new_y
 *   [4] C_consumed_x  [5] C_consumed_y
 *
 * Proof format: uint256[8] EVM-ready (pB Fp2-swapped via applyPiBSwap).
 *
 * Reference: circuits/aggregate-claim-batch/test/helpers/proof-inputs.cjs
 */

import { computeCommitment, addCommitmentsLocal } from "../primitives/pedersen.js";
import { applyPiBSwap, evmProofToUint256Array } from "../utils/pi-b-swap.js";
import type { SnarkJSProof, ProofUint256 } from "../types/proof.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BatchClaimInputs {
  /** User's current hidden balance (amount scalar). */
  oldBalance: bigint;
  /** Current Pedersen blinding factor. */
  oldBlinding: bigint;
  /** Fresh blinding for the new post-claim commitment. */
  newBlinding: bigint;
  /**
   * Notes to consume. Up to 50 entries. Excess entries are silently truncated.
   * Notes with zero amount are allowed (and will be padded if fewer than 50).
   */
  notes: Array<{ amount: bigint; blinding: bigint }>;
}

export interface BatchClaimProof {
  /**
   * 6-element EVM-packed public input array:
   *   [C_old_x, C_old_y, C_new_x, C_new_y, C_consumed_x, C_consumed_y]
   * Passed directly to JanusToken.claimBatch(publicInputs, proof).
   */
  publicInputs: [bigint, bigint, bigint, bigint, bigint, bigint];
  /**
   * Groth16 proof packed as uint256[8] (pB Fp2-swapped — EVM-ready).
   * Passed directly to JanusToken.claimBatch(publicInputs, proof).
   */
  proof: ProofUint256;
  /** New commitment (C_new) after aggregation — save as new state. */
  newCommit: { x: bigint; y: bigint };
  /** Sum of consumed note commitments (C_consumed) — for verification. */
  consumedCommit: { x: bigint; y: bigint };
  /** New balance (oldBalance + Σ amounts). */
  newBalance: bigint;
  /** Raw snarkJS proof (for debugging / off-chain verification). */
  rawProof: SnarkJSProof;
  /** Raw public signals from snarkJS (decimal strings). */
  rawPublicSignals: string[];
}

// ---------------------------------------------------------------------------
// Circuit path resolution (Node-only, lazy)
// ---------------------------------------------------------------------------

interface CircuitPaths {
  wasm: string;
  zkey: string;
}

let _defaultPaths: CircuitPaths | undefined;

/**
 * Resolve the default circuit artifact paths bundled with the SDK.
 * Throws on browser environments (proof generation requires file I/O).
 */
async function getDefaultCircuitPaths(): Promise<CircuitPaths> {
  if (typeof window !== "undefined") {
    throw new Error(
      "buildBatchClaimProof requires a Node.js runtime (wasm/zkey file I/O). " +
        "Call it from an API route or server action, not a client component."
    );
  }
  if (_defaultPaths) return _defaultPaths;
  const { fileURLToPath } = await import("url");
  const { dirname, resolve } = await import("path");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // dist/proof/ → package root is two levels up
  const PACKAGE_ROOT = resolve(__dirname, "..", "..");
  _defaultPaths = {
    wasm: resolve(
      PACKAGE_ROOT,
      "circuits/aggregate-claim-batch/build/confidential_claim_batch_js/confidential_claim_batch.wasm"
    ),
    zkey: resolve(
      PACKAGE_ROOT,
      "circuits/aggregate-claim-batch/ceremony/cb_final.zkey"
    ),
  };
  return _defaultPaths;
}

// ---------------------------------------------------------------------------
// Padding helper
// ---------------------------------------------------------------------------

const CIRCUIT_N = 50;

/**
 * Pad or truncate a note array to exactly CIRCUIT_N elements.
 * Zero-amount, zero-blinding notes are inserted for padding.
 */
function padNotes(
  notes: Array<{ amount: bigint; blinding: bigint }>
): Array<{ amount: bigint; blinding: bigint }> {
  const out = notes.slice(0, CIRCUIT_N);
  while (out.length < CIRCUIT_N) {
    out.push({ amount: 0n, blinding: 0n });
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildBatchClaimProof
// ---------------------------------------------------------------------------

export interface BatchClaimProofOptions {
  /** Override WASM path (useful for testing against a custom key). */
  wasmPath?: string;
  /** Override zkey path (useful for testing against a custom key). */
  zkeyPath?: string;
}

/**
 * Generate a Groth16 ConfidentialClaimBatch proof.
 *
 * @param inputs   BatchClaimInputs (oldBalance, oldBlinding, newBlinding, notes)
 * @param options  Optional circuit artifact path overrides
 */
export async function buildBatchClaimProof(
  inputs: BatchClaimInputs,
  options?: BatchClaimProofOptions
): Promise<BatchClaimProof> {
  // ── Resolve circuit artifact paths ──────────────────────────────────────
  let wasmPath = options?.wasmPath;
  let zkeyPath = options?.zkeyPath;
  if (!wasmPath || !zkeyPath) {
    const paths = await getDefaultCircuitPaths();
    wasmPath = wasmPath ?? paths.wasm;
    zkeyPath = zkeyPath ?? paths.zkey;
  }

  // ── 1. Pad notes to N=50 ────────────────────────────────────────────────
  const paddedNotes = padNotes(inputs.notes);
  const amounts = paddedNotes.map((n) => n.amount);
  const blindings = paddedNotes.map((n) => n.blinding);

  // ── 2. Compute C_old = Commit(oldBalance, oldBlinding) ──────────────────
  const C_old = await computeCommitment(inputs.oldBalance, inputs.oldBlinding);

  // ── 3. Compute newBalance = oldBalance + Σ amounts ──────────────────────
  const sumAmounts = amounts.reduce((acc, a) => acc + a, 0n);
  const newBalance = inputs.oldBalance + sumAmounts;

  // ── 4. Compute C_new = Commit(newBalance, newBlinding) ──────────────────
  const C_new = await computeCommitment(newBalance, inputs.newBlinding);

  // ── 5. Compute C_consumed = Σ Commit(amounts[i], blindings[i]) ──────────
  //      Uses chained babyAdd (homomorphic point addition) — NOT scalar sum.
  //      Identity element is (0, 1). This matches the circuit's accumulation.
  let C_consumed = { x: 0n, y: 1n };
  for (let i = 0; i < CIRCUIT_N; i++) {
    const noteCommit = await computeCommitment(amounts[i], blindings[i]);
    C_consumed = await addCommitmentsLocal(C_consumed, noteCommit);
  }

  // ── 6. Build circuit input (matches proof-inputs.cjs buildClaimInput) ───
  const circuitInput = {
    // Public inputs (as string arrays — circom convention)
    C_old: [C_old.x.toString(), C_old.y.toString()],
    C_new: [C_new.x.toString(), C_new.y.toString()],
    C_consumed: [C_consumed.x.toString(), C_consumed.y.toString()],
    // Private inputs
    oldBalance: inputs.oldBalance.toString(),
    oldBlinding: inputs.oldBlinding.toString(),
    newBlinding: inputs.newBlinding.toString(),
    amounts: amounts.map((a) => a.toString()),
    blindings: blindings.map((b) => b.toString()),
  };

  // ── 7. Run groth16.fullProve ─────────────────────────────────────────────
  const snarkjs = await import("snarkjs");
  const { proof, publicSignals } = (await snarkjs.groth16.fullProve(
    circuitInput,
    wasmPath,
    zkeyPath
  )) as { proof: SnarkJSProof; publicSignals: string[] };

  if (publicSignals.length !== 6) {
    throw new Error(
      `buildBatchClaimProof: expected 6 public signals, got ${publicSignals.length}. ` +
        `Check that the circuit wasm/zkey matches ConfidentialClaimBatch(N=50).`
    );
  }

  // ── 8. Apply Fp2 swap and pack proof ────────────────────────────────────
  const evmProof = applyPiBSwap(proof);
  const proofUint256 = evmProofToUint256Array(evmProof);

  // Public inputs in EVM order: [C_old_x, C_old_y, C_new_x, C_new_y, C_consumed_x, C_consumed_y]
  const publicInputs: [bigint, bigint, bigint, bigint, bigint, bigint] = [
    BigInt(publicSignals[0]),
    BigInt(publicSignals[1]),
    BigInt(publicSignals[2]),
    BigInt(publicSignals[3]),
    BigInt(publicSignals[4]),
    BigInt(publicSignals[5]),
  ];

  return {
    publicInputs,
    proof: proofUint256,
    newCommit: { x: C_new.x, y: C_new.y },
    consumedCommit: { x: C_consumed.x, y: C_consumed.y },
    newBalance,
    rawProof: proof,
    rawPublicSignals: publicSignals,
  };
}
