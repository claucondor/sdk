/**
 * crypto/shielded-transfer.ts — buildShieldedTransferProof
 *
 * Generates the aggregate ConfidentialTransfer Groth16 proof that gates
 * JanusToken.shieldedTransfer (amount HIDDEN on calldata, events, storage).
 *
 * Circuit (confidential_transfer_aggregate.circom):
 *   private inputs: old_value (128-bit), old_blinding (252-bit),
 *                   transfer_value (128-bit), transfer_blinding (252-bit),
 *                   new_blinding (252-bit)
 *   public inputs : old_commit[2], transfer_commit[2], new_commit[2]
 *   asserts       : all three commits consistent via 2-gen Pedersen
 *                   transfer_value <= old_value (underflow prevention)
 *                   all values in [0, 2^128)
 *
 * Public input layout (unchanged from v0.6 — adapters need no change):
 *   [0..1] old_commit (C_old)
 *   [2..3] transfer_commit (C_tx)
 *   [4..5] new_commit (C_new)
 */

import { applyPiBSwap, evmProofToUint256Array } from "../utils/pi-b-swap.js";
import { computeCommitment } from "../primitives/pedersen.js";
import type { Point } from "../types/commitment.js";
import type { SnarkJSProof, ProofUint256 } from "../types/proof.js";
import { SUBORDER } from "@openjanus/commitment";

// ---------------------------------------------------------------------------
// Bundled circuit artifact paths — RESOLVED LAZILY (Node-only)
// ---------------------------------------------------------------------------

interface CircuitPaths {
  wasm: string;
  zkey: string;
}

let _circuitPaths: CircuitPaths | undefined;

async function getCircuitPaths(): Promise<CircuitPaths> {
  if (typeof window !== "undefined") {
    throw new Error(
      "buildShieldedTransferProof requires Node.js runtime (wasm/zkey file I/O). " +
        "Call it from an API route or server action, not directly from a client component."
    );
  }
  if (_circuitPaths) return _circuitPaths;
  const { fileURLToPath } = await import("url");
  const { dirname, resolve } = await import("path");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const PACKAGE_ROOT = resolve(__dirname, "..", "..");
  _circuitPaths = {
    wasm: resolve(PACKAGE_ROOT, "circuits/aggregate/confidential_transfer_aggregate.wasm"),
    zkey: resolve(PACKAGE_ROOT, "circuits/aggregate/confidential_transfer_aggregate_test.zkey"),
  };
  return _circuitPaths;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ShieldedTransferProofInput {
  /** Sender's current cleartext balance (must equal old_commit's value). */
  oldBalance: bigint;
  /** Blinding scalar of the sender's current commit (252-bit, mod SUBORDER). */
  oldBlinding: bigint;
  /** Amount to transfer (must be <= oldBalance, in [0, 2^128)). */
  transferAmount: bigint;
  /** Fresh 252-bit blinding for the transfer commitment. */
  transferBlinding: bigint;
  /** Fresh 252-bit blinding for the sender's NEW (residual) commitment. */
  newBlinding: bigint;
}

export interface ShieldedTransferProofResult {
  /** Old, transfer, and new commitments (BabyJubJub points). */
  commitments: {
    oldCommit: Point;
    transferCommit: Point;
    newCommit: Point;
  };
  /** Convenience [Cx, Cy] for the transfer commit (= txCommit used elsewhere). */
  txCommit: readonly [bigint, bigint];
  /** Groth16 proof as uint256[8] (pi_b Fp2-swapped — EVM-ready). */
  proof: ProofUint256;
  /** Public inputs as uint256[6]: [C_old, C_tx, C_new]. */
  publicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  /** Raw snarkJS proof + publicSignals (for off-chain verify). */
  rawProof: SnarkJSProof;
  rawPublicSignals: string[];
}

export interface ProofArtifactOptions {
  wasmPath?: string;
  zkeyPath?: string;
}

// ---------------------------------------------------------------------------
// buildShieldedTransferProof
// ---------------------------------------------------------------------------

/**
 * Generate the aggregate ConfidentialTransfer Groth16 proof.
 *
 * Off-chain we compute all three 2-gen Pedersen commitments and feed them as
 * public inputs. The circuit re-derives them from (value, blinding) private
 * inputs and asserts equality. The homomorphism guarantees that the on-chain
 * accumulated commitment equals Commit(Σv_i, Σr_i) — a valid old_commit that
 * this proof can satisfy with the running sums (oldBalance, oldBlinding).
 *
 * IMPORTANT: The caller MUST persist newBlinding paired with the new residual
 * balance — required to construct the next shielded transfer from this account.
 *
 * @param input    Transfer parameters (see ShieldedTransferProofInput)
 * @param options  Optional WASM/zkey path overrides
 */
export async function buildShieldedTransferProof(
  input: ShieldedTransferProofInput,
  options?: ProofArtifactOptions
): Promise<ShieldedTransferProofResult> {
  let wasmPath = options?.wasmPath;
  let zkeyPath = options?.zkeyPath;
  if (!wasmPath || !zkeyPath) {
    const paths = await getCircuitPaths();
    wasmPath = wasmPath ?? paths.wasm;
    zkeyPath = zkeyPath ?? paths.zkey;
  }

  // Input range guards — aggregate circuit uses Num2Bits(128) for values
  if (input.oldBalance < 0n || input.oldBalance >= 1n << 128n) {
    throw new RangeError(
      `buildShieldedTransferProof: oldBalance must be in [0, 2^128), got ${input.oldBalance}`
    );
  }
  if (input.transferAmount < 0n || input.transferAmount > input.oldBalance) {
    throw new RangeError(
      `buildShieldedTransferProof: transferAmount must be in [0, oldBalance], got ${input.transferAmount} (balance ${input.oldBalance})`
    );
  }
  // Blinding scalars: aggregate circuit uses Num2Bits(252)
  const MAX_BLINDING = (1n << 252n) - 1n;
  if (input.oldBlinding < 0n || input.oldBlinding > MAX_BLINDING) {
    throw new RangeError(`buildShieldedTransferProof: oldBlinding out of [0, 2^252) range`);
  }
  if (input.transferBlinding < 0n || input.transferBlinding > MAX_BLINDING) {
    throw new RangeError(`buildShieldedTransferProof: transferBlinding out of [0, 2^252) range`);
  }
  if (input.newBlinding < 0n || input.newBlinding > MAX_BLINDING) {
    throw new RangeError(`buildShieldedTransferProof: newBlinding out of [0, 2^252) range`);
  }

  const newBalance = input.oldBalance - input.transferAmount;

  const [oldCommit, transferCommit, newCommit] = await Promise.all([
    computeCommitment(input.oldBalance, input.oldBlinding),
    computeCommitment(input.transferAmount, input.transferBlinding),
    computeCommitment(newBalance, input.newBlinding),
  ]);

  const snarkjs = await import("snarkjs");
  const circuitInput = {
    old_value: input.oldBalance.toString(),
    old_blinding: input.oldBlinding.toString(),
    transfer_value: input.transferAmount.toString(),
    transfer_blinding: input.transferBlinding.toString(),
    new_blinding: input.newBlinding.toString(),
    old_commit: [oldCommit.x.toString(), oldCommit.y.toString()],
    transfer_commit: [transferCommit.x.toString(), transferCommit.y.toString()],
    new_commit: [newCommit.x.toString(), newCommit.y.toString()],
  };

  const { proof, publicSignals } = (await snarkjs.groth16.fullProve(
    circuitInput,
    wasmPath,
    zkeyPath
  )) as { proof: SnarkJSProof; publicSignals: string[] };

  if (publicSignals.length !== 6) {
    throw new Error(
      `buildShieldedTransferProof: expected 6 public signals, got ${publicSignals.length}`
    );
  }

  const evmProof = applyPiBSwap(proof);
  const proofUint256 = evmProofToUint256Array(evmProof);

  const publicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint] = [
    BigInt(publicSignals[0]),
    BigInt(publicSignals[1]),
    BigInt(publicSignals[2]),
    BigInt(publicSignals[3]),
    BigInt(publicSignals[4]),
    BigInt(publicSignals[5]),
  ];

  return {
    commitments: { oldCommit, transferCommit, newCommit },
    txCommit: [transferCommit.x, transferCommit.y] as const,
    proof: proofUint256,
    publicInputs,
    rawProof: proof,
    rawPublicSignals: publicSignals,
  };
}

// Suppress unused import warning — SUBORDER used as reference constant
void SUBORDER;
