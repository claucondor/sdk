/**
 * crypto/shielded-transfer.ts — buildShieldedTransferProof
 *
 * Generates the v0.3 ConfidentialTransfer Groth16 proof that gates
 * JanusToken.shieldedTransfer (amount HIDDEN on calldata, events, storage).
 *
 * Circuit (confidential_transfer.circom):
 *   private inputs: old_value, old_blinding, transfer_value,
 *                   transfer_blinding, new_blinding
 *   public inputs : old_commit[2], transfer_commit[2], new_commit[2]
 *   asserts       : commitments are consistent Pedersen of (value, blinding)
 *                   transfer_value <= old_value (underflow prevention)
 *                   transfer_value in [0, 2^64) (range check via Num2Bits)
 *
 * publicSignals order:
 *   [0..1] old_commit (C_old)
 *   [2..3] transfer_commit (C_tx)
 *   [4..5] new_commit (C_new)
 *
 * The SDK is generic — apps decide how to materialize old_blinding and how
 * to track new_blinding for the next transfer. The caller MUST persist
 * new_blinding (paired with the new value) for any future spend.
 *
 * Trusted setup (v0.3): see lab `cadence-crypto-lab/modules/zk/confidential-transfer-circuit`.
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { applyPiBSwap, evmProofToUint256Array } from "../utils/pi-b-swap.js";
import { computeCommitment } from "../primitives/pedersen.js";
import type { Point } from "../types/commitment.js";
import type { SnarkJSProof, ProofUint256 } from "../types/proof.js";

// ---------------------------------------------------------------------------
// Bundled circuit artifact paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PACKAGE_ROOT = resolve(__dirname, "..", "..");

const CONFIDENTIAL_TRANSFER_WASM = resolve(
  PACKAGE_ROOT,
  "circuits/v0.3/confidential_transfer.wasm"
);
const CONFIDENTIAL_TRANSFER_ZKEY = resolve(
  PACKAGE_ROOT,
  "circuits/v0.3/confidential_transfer_final.zkey"
);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ShieldedTransferProofInput {
  /** Sender's current cleartext balance (must equal old_commit's value). */
  oldBalance: bigint;
  /** Blinding factor of the sender's current commit (stored locally). */
  oldBlinding: bigint;
  /** Amount to transfer (must be <= oldBalance, in [0, 2^64)). */
  transferAmount: bigint;
  /** Fresh 128-bit blinding for the transfer commitment. */
  transferBlinding: bigint;
  /** Fresh 128-bit blinding for the sender's NEW (residual) commitment. */
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
 * Generate the v0.3 ConfidentialTransfer Groth16 proof.
 *
 * Off-chain we compute all three Pedersen commitments and feed them as
 * public inputs. The circuit re-derives them from the (value, blinding)
 * private inputs and asserts equality.
 *
 * Use this proof for JanusToken.shieldedTransfer (and the
 * transfer-half of JanusFlow.unwrap with transferAmount = claimedAmount).
 *
 * IMPORTANT: The caller MUST persist `newBlinding` paired with the new
 * residual balance — it is required to construct the next shielded transfer
 * from this account.
 *
 * @param input    Transfer parameters (see ShieldedTransferProofInput)
 * @param options  Optional WASM/zkey path overrides
 */
export async function buildShieldedTransferProof(
  input: ShieldedTransferProofInput,
  options?: ProofArtifactOptions
): Promise<ShieldedTransferProofResult> {
  const wasmPath = options?.wasmPath ?? CONFIDENTIAL_TRANSFER_WASM;
  const zkeyPath = options?.zkeyPath ?? CONFIDENTIAL_TRANSFER_ZKEY;

  // Input range guards (loud failure beats silent witness rejection)
  if (input.oldBalance < 0n || input.oldBalance >= 1n << 64n) {
    throw new RangeError(
      `buildShieldedTransferProof: oldBalance must be in [0, 2^64), got ${input.oldBalance}`
    );
  }
  if (input.transferAmount < 0n || input.transferAmount > input.oldBalance) {
    throw new RangeError(
      `buildShieldedTransferProof: transferAmount must be in [0, oldBalance], got ${input.transferAmount} (balance ${input.oldBalance})`
    );
  }
  if (input.oldBlinding < 0n || input.oldBlinding >= 1n << 128n) {
    throw new RangeError(`buildShieldedTransferProof: oldBlinding out of range`);
  }
  if (input.transferBlinding < 0n || input.transferBlinding >= 1n << 128n) {
    throw new RangeError(`buildShieldedTransferProof: transferBlinding out of range`);
  }
  if (input.newBlinding < 0n || input.newBlinding >= 1n << 128n) {
    throw new RangeError(`buildShieldedTransferProof: newBlinding out of range`);
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
