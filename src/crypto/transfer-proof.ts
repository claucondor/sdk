/**
 * crypto/transfer-proof.ts — ZK proof generation for JanusToken confidentialTransfer
 *
 * This is the primary entry point for generating proofs for:
 *   JanusToken.confidentialTransfer(to, publicInputs, proof)
 *   JanusFlow.confidentialTransfer(to, oldCommit, txCommit, newCommit, proof)
 *
 * Circuit: ConfidentialTransfer v2
 *   Artifacts: /home/oydual3/cadence-crypto-lab/modules/zk/confidential-transfer-circuit/
 *     - circuit/confidentialTransfer.wasm
 *     - setup/confidentialTransfer_final.zkey
 *     - setup/verification_key.json
 *
 * The proof attests: "I know (old_value, old_blinding, transfer_value, ...) such that:
 *   C_old = Pedersen(old_value, old_blinding)
 *   C_tx  = Pedersen(transfer_value, transfer_blinding)
 *   C_new = Pedersen(old_value - transfer_value, new_blinding)
 *   old_value >= transfer_value (range check)"
 */

import type { CommitmentXY } from "../types/commitment";
import type { ProofUint256, PublicInputsUint256 } from "../types/proof";
import { computeCommitment } from "../primitives/pedersen";
import { proveForEVM, verifyLocally } from "../primitives/groth16";

/** Input for generating a confidential transfer proof */
export interface TransferProofInput {
  /** Sender's current balance (uint64) */
  oldBalance: bigint;
  /** Sender's blinding factor at time of wrap/mint (store this!) */
  oldBlinding: bigint;
  /** Amount to transfer (must be <= oldBalance) */
  transferAmount: bigint;
  /** Fresh random blinding for the transfer commitment */
  transferBlinding: bigint;
  /** Fresh random blinding for sender's new (residual) commitment */
  newBlinding: bigint;
  /** Path to circuit WASM file */
  wasmPath: string;
  /** Path to proving key (.zkey) file */
  zkeyPath: string;
  /** Path to verification key JSON (optional — enables local pre-verification) */
  vkPath?: string;
}

/** Result of proof generation — all data needed for on-chain submission */
export interface TransferProofResult {
  /**
   * Groth16 proof encoded as uint256[8] (pi_b Fp2-swapped for EIP-197).
   * Pass directly to JanusToken.confidentialTransfer(to, publicInputs, proof).
   */
  proof: ProofUint256;
  /**
   * Public inputs: [C_old.x, C_old.y, C_tx.x, C_tx.y, C_new.x, C_new.y].
   * Pass directly to JanusToken.confidentialTransfer(to, publicInputs, proof).
   */
  publicInputs: PublicInputsUint256;
  /** The three commitment points (for reference / storage) */
  commitments: {
    oldCommit: CommitmentXY;
    transferCommit: CommitmentXY;
    newCommit: CommitmentXY;
  };
  /** True if the proof passed local pre-verification (only set if vkPath provided) */
  locallyVerified: boolean;
}

/**
 * Generate a Groth16 transfer proof for JanusToken.confidentialTransfer.
 *
 * Steps performed:
 *   1. Validate inputs (transfer <= balance, values in range)
 *   2. Compute the three Pedersen commitments (old, transfer, new)
 *   3. Build circuit inputs
 *   4. Generate Groth16 proof via snarkjs
 *   5. Apply EIP-197 pi_b Fp2 swap
 *   6. Optionally verify locally against the verification key
 *
 * @param input  Transfer parameters + circuit paths
 * @returns      Proof + public inputs ready for on-chain submission
 */
export async function buildTransferProof(
  input: TransferProofInput
): Promise<TransferProofResult> {
  const {
    oldBalance,
    oldBlinding,
    transferAmount,
    transferBlinding,
    newBlinding,
    wasmPath,
    zkeyPath,
    vkPath,
  } = input;

  // Validate
  if (transferAmount > oldBalance) {
    throw new RangeError(
      `buildTransferProof: transfer amount ${transferAmount} exceeds balance ${oldBalance}`
    );
  }
  if (oldBalance >= 1n << 64n) {
    throw new RangeError(`buildTransferProof: oldBalance must be < 2^64`);
  }

  // 1. Compute the three commitments
  const newBalance = oldBalance - transferAmount;
  const [oldCommit, transferCommit, newCommit] = await Promise.all([
    computeCommitment(oldBalance, oldBlinding),
    computeCommitment(transferAmount, transferBlinding),
    computeCommitment(newBalance, newBlinding),
  ]);

  // 2. Build circuit input (matches ConfidentialTransfer v2 signal names)
  const circuitInput = {
    old_value: oldBalance.toString(),
    old_blinding: oldBlinding.toString(),
    transfer_value: transferAmount.toString(),
    transfer_blinding: transferBlinding.toString(),
    new_blinding: newBlinding.toString(),
    old_commit: [oldCommit.x.toString(), oldCommit.y.toString()],
    transfer_commit: [transferCommit.x.toString(), transferCommit.y.toString()],
    new_commit: [newCommit.x.toString(), newCommit.y.toString()],
  };

  // 3. Generate proof + apply EIP-197 swap
  const { rawProof, proofUint256, publicSignals } = await proveForEVM(circuitInput, {
    wasmPath,
    zkeyPath,
  });

  // 4. Encode public inputs as uint256[6]
  const publicInputs: PublicInputsUint256 = [
    BigInt(publicSignals[0]),
    BigInt(publicSignals[1]),
    BigInt(publicSignals[2]),
    BigInt(publicSignals[3]),
    BigInt(publicSignals[4]),
    BigInt(publicSignals[5]),
  ];

  // 5. Optional local verification
  let locallyVerified = false;
  if (vkPath) {
    const fs = await import("fs");
    const vk = JSON.parse(fs.readFileSync(vkPath, "utf8")) as object;
    locallyVerified = await verifyLocally(vk, rawProof, publicSignals);
  }

  return {
    proof: proofUint256,
    publicInputs,
    commitments: { oldCommit, transferCommit, newCommit },
    locallyVerified,
  };
}
