/**
 * batchClaim/BatchClaimClient.ts — BatchClaimClient
 *
 * EVM client for JanusToken.claimBatch (v0.8.1).
 *
 * Aggregates up to 50 ShieldedInbox notes into the caller's shielded balance
 * via a single Groth16 proof (ConfidentialClaimBatch circuit, N=50).
 *
 * Usage:
 *   const client = new BatchClaimClient(signer, JANUS_FLOW_PROXY);
 *   // If you already have a proof (e.g. generated server-side):
 *   const receipt = await client.claimBatch(publicInputs, proof);
 *
 *   // Or generate + submit in one call:
 *   const { tx, newCommit } = await client.buildAndClaim({
 *     oldBalance, oldBlinding, newBlinding,
 *     notesToConsume: [{ amount, blinding }, ...],
 *     zkeyPath, wasmPath,   // optional — uses bundled circuit by default
 *   });
 *
 * Deployed v0.8.1 proxies (addresses never change across UUPS upgrades):
 *   JanusFlow  proxy: 0xA64340C1d356835A2450306Ffd290Ed52c001Ad3
 *   JanusERC20 proxy: 0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d
 */

import { ethers } from "ethers";
import { buildBatchClaimProof } from "../proof/batch-claim.js";
import type { BatchClaimProofOptions } from "../proof/batch-claim.js";
import type { ProofUint256 } from "../types/proof.js";

// ---------------------------------------------------------------------------
// ABI (minimal surface — only what BatchClaimClient needs)
// ---------------------------------------------------------------------------

const BATCH_CLAIM_ABI = [
  // v0.8.1 batch claim entry function
  "function claimBatch(uint256[6] calldata publicInputs, uint256[8] calldata proof) external",
  // Verifier address (slot 94 in JanusToken, slot 95 in JanusERC20)
  "function batchClaimVerifier() view returns (address)",
  // Protocol version constant
  "function VERSION() view returns (string)",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildAndClaimParams {
  /** User's current hidden balance (amount scalar). */
  oldBalance: bigint;
  /** Current Pedersen blinding factor. */
  oldBlinding: bigint;
  /** Fresh blinding chosen by the user for the new post-claim commitment. */
  newBlinding: bigint;
  /**
   * Notes to consume from the ShieldedInbox.
   * Each note was received via shieldedTransfer and carries an amount + blinding.
   * Maximum 50 notes; excess entries are silently truncated.
   */
  notesToConsume: Array<{ amount: bigint; blinding: bigint }>;
  /**
   * Optional circuit artifact paths.
   * If omitted, uses the wasm/zkey bundled with the SDK.
   * Override in tests to point at a test key (faster proving).
   */
  circuitOptions?: BatchClaimProofOptions;
}

export interface BuildAndClaimResult {
  /** Confirmed transaction receipt from JanusToken.claimBatch(). */
  tx: ethers.ContractTransactionReceipt;
  /** New on-chain commitment after the claim — save this as your new state. */
  newCommit: { x: bigint; y: bigint };
  /** New plaintext balance (oldBalance + Σ consumed note amounts). */
  newBalance: bigint;
  /** Public inputs that were submitted (for logging / verification). */
  publicInputs: [bigint, bigint, bigint, bigint, bigint, bigint];
}

// ---------------------------------------------------------------------------
// BatchClaimClient
// ---------------------------------------------------------------------------

export class BatchClaimClient {
  private readonly contract: ethers.Contract;

  constructor(
    private readonly signer: ethers.Signer,
    private readonly janusTokenAddress: string
  ) {
    this.contract = new ethers.Contract(
      janusTokenAddress,
      BATCH_CLAIM_ABI,
      signer
    );
  }

  // ── On-chain call with pre-built proof ──────────────────────────────────

  /**
   * Submit a pre-built batch claim proof to JanusToken.claimBatch().
   *
   * Use this when the proof was generated off-chain (e.g. in a server action)
   * and you only need to submit the calldata.
   *
   * @param publicInputs  [C_old_x, C_old_y, C_new_x, C_new_y, C_consumed_x, C_consumed_y]
   * @param proof         uint256[8] Groth16 proof (pB Fp2-swapped — EVM-ready)
   */
  async claimBatch(
    publicInputs: [bigint, bigint, bigint, bigint, bigint, bigint],
    proof: ProofUint256
  ): Promise<ethers.ContractTransactionReceipt> {
    if (publicInputs.length !== 6) {
      throw new TypeError(
        `BatchClaimClient.claimBatch: publicInputs must have exactly 6 elements, got ${publicInputs.length}`
      );
    }
    if (proof.length !== 8) {
      throw new TypeError(
        `BatchClaimClient.claimBatch: proof must have exactly 8 elements, got ${proof.length}`
      );
    }

    const tx = await this.contract.claimBatch(
      [...publicInputs],
      [...proof]
    ) as ethers.ContractTransactionResponse;

    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error("BatchClaimClient.claimBatch: transaction receipt is null");
    }
    return receipt;
  }

  // ── Full flow: generate proof + submit ──────────────────────────────────

  /**
   * Generate a ConfidentialClaimBatch Groth16 proof and submit it on-chain.
   *
   * 1. Pads notesToConsume to N=50.
   * 2. Computes C_old, C_new, C_consumed via Pedersen arithmetic.
   * 3. Runs groth16.fullProve against the bundled circuit.
   * 4. Calls JanusToken.claimBatch() and waits for confirmation.
   *
   * Returns the receipt and the new commitment (save as your updated state).
   */
  async buildAndClaim(params: BuildAndClaimParams): Promise<BuildAndClaimResult> {
    const { proof: builtProof, publicInputs, newCommit, newBalance } =
      await buildBatchClaimProof(
        {
          oldBalance: params.oldBalance,
          oldBlinding: params.oldBlinding,
          newBlinding: params.newBlinding,
          notes: params.notesToConsume,
        },
        params.circuitOptions
      );

    const receipt = await this.claimBatch(publicInputs, builtProof);

    return { tx: receipt, newCommit, newBalance, publicInputs };
  }

  // ── View helpers ─────────────────────────────────────────────────────────

  /**
   * Return the ConfidentialClaimBatchVerifier address wired to this proxy.
   * Reverts if slot 94 is still address(0) (verifier not yet set).
   */
  async getVerifierAddress(): Promise<string> {
    return await this.contract.batchClaimVerifier() as string;
  }

  /**
   * Return the protocol VERSION constant from the implementation contract.
   * Expected: "0.8.1" for the v0.8.1 upgrade.
   */
  async getVersion(): Promise<string> {
    return await this.contract.VERSION() as string;
  }
}
