/**
 * types/proof.ts — Shared Groth16 proof types
 *
 * Used across primitives/groth16 and crypto/transfer-proof.
 * Keep this file pure types — no runtime code.
 */

/** Raw snarkJS proof object (returned by groth16.fullProve) */
export interface SnarkJSProof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: string;
  curve: string;
}

/**
 * Proof formatted for EVM verifyProof() call.
 * pi_b Fp2 swap is applied (EIP-197 encoding).
 */
export interface EVMProof {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
}

/**
 * Proof encoded as uint256[8] for on-chain contract calls.
 * Order: [pA.x, pA.y, pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC.x, pC.y]
 */
export type ProofUint256 = [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

/** Public signals for the ConfidentialTransfer circuit (6 values, decoded) */
export interface ConfidentialTransferPublicInputs {
  oldCommitX: bigint;
  oldCommitY: bigint;
  transferCommitX: bigint;
  transferCommitY: bigint;
  newCommitX: bigint;
  newCommitY: bigint;
}

/** Public inputs encoded as uint256[6] for on-chain contract calls */
export type PublicInputsUint256 = [bigint, bigint, bigint, bigint, bigint, bigint];
