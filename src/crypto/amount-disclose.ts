/**
 * crypto/amount-disclose.ts — buildAmountDiscloseProof
 *
 * Wraps the v0.3 AmountDisclose Groth16 circuit. Proves that a Pedersen
 * commitment binds to a PUBLIC scalar amount, used by JanusFlow.wrap (and
 * one of the two proofs verified by JanusFlow.unwrap).
 *
 * Circuit (amount_disclose.circom):
 *   private inputs: blinding
 *   public inputs : claimed_amount, commit[2]
 *   asserts       : commit == Pedersen(claimed_amount, blinding)
 *                   claimed_amount in [0, 2^64)
 *                   blinding       in [0, 2^128)
 *
 * publicSignals order (Solidity verifier-call order):
 *   [0] claimed_amount
 *   [1] commit[0]   (Cx)
 *   [2] commit[1]   (Cy)
 *
 * Trusted setup (v0.5.1):
 *   Phase 1: Hermez pot18 (canonical GCS source, blake2b verified)
 *   Phase 2: 1 named contributor (openjanus-v0.5.1-pot18-contributor-1)
 *   Beacon : Flow VRF testnet block 324226714
 *   Verify : see circuits/v0.5.1/CEREMONY-RECORD.json
 *
 * v0.5 change: amount range check bumped from [0, 2^64) to [0, 2^128) to
 * match the updated Num2Bits(128) constraint in amount_disclose.circom.
 */

import { applyPiBSwap, evmProofToUint256Array } from "../utils/pi-b-swap.js";
import { computeCommitment } from "../primitives/pedersen.js";
import type { Point } from "../types/commitment.js";
import type { SnarkJSProof, ProofUint256 } from "../types/proof.js";

// ---------------------------------------------------------------------------
// Bundled circuit artifact paths — RESOLVED LAZILY (Node-only)
// ---------------------------------------------------------------------------
// `url.fileURLToPath` is Node-only and breaks browser bundlers at parse time
// if imported at the top level. We defer the import so the crypto barrel
// stays browser-safe; this proof function still throws clearly if invoked
// in a browser (no wasm file I/O available client-side).

interface CircuitPaths {
  wasm: string;
  zkey: string;
}

let _circuitPaths: CircuitPaths | undefined;

async function getCircuitPaths(): Promise<CircuitPaths> {
  if (typeof window !== "undefined") {
    throw new Error(
      "buildAmountDiscloseProof requires Node.js runtime (wasm/zkey file I/O). " +
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
    wasm: resolve(PACKAGE_ROOT, "circuits/v0.3/amount_disclose.wasm"),
    zkey: resolve(PACKAGE_ROOT, "circuits/v0.3/amount_disclose_final.zkey"),
  };
  return _circuitPaths;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AmountDiscloseProofInput {
  /** Cleartext amount being bound to the commitment (in [0, 2^64)). */
  amount: bigint;
  /** 128-bit Pedersen blinding factor (in [0, 2^128)) — keep private. */
  blinding: bigint;
}

export interface AmountDiscloseProofResult {
  /** Pedersen commitment of (amount, blinding). */
  commitment: Point;
  /** Convenience [Cx, Cy] tuple to splat into wrap/unwrap calls. */
  txCommit: readonly [bigint, bigint];
  /** Groth16 proof as uint256[8] (pi_b Fp2-swapped — EVM-ready). */
  proof: ProofUint256;
  /** Public inputs [claimed_amount, Cx, Cy] as bigint[3]. */
  publicInputs: readonly [bigint, bigint, bigint];
  /** Raw snarkJS proof (for off-chain verification or debugging). */
  rawProof: SnarkJSProof;
  /** Raw snarkJS publicSignals (decimal strings). */
  rawPublicSignals: string[];
}

export interface ProofArtifactOptions {
  wasmPath?: string;
  zkeyPath?: string;
}

// ---------------------------------------------------------------------------
// buildAmountDiscloseProof
// ---------------------------------------------------------------------------

/**
 * Generate the v0.3 AmountDisclose Groth16 proof.
 *
 * Off-chain, we compute the Pedersen commitment of (amount, blinding) and
 * feed it as a public input to the circuit. The on-chain verifier just
 * checks that the supplied commit matches the (re-computed) Pedersen hash.
 *
 * Use this proof for JanusFlow.wrap (amount = msg.value in attoFLOW) and
 * for the amount-disclose half of JanusFlow.unwrap (amount = claimedAmount
 * in attoFLOW).
 *
 * @param input    { amount, blinding }
 * @param options  Optional WASM/zkey path overrides
 */
export async function buildAmountDiscloseProof(
  input: AmountDiscloseProofInput,
  options?: ProofArtifactOptions
): Promise<AmountDiscloseProofResult> {
  let wasmPath = options?.wasmPath;
  let zkeyPath = options?.zkeyPath;
  if (!wasmPath || !zkeyPath) {
    const paths = await getCircuitPaths();
    wasmPath = wasmPath ?? paths.wasm;
    zkeyPath = zkeyPath ?? paths.zkey;
  }

  if (input.amount < 0n || input.amount >= 1n << 64n) {
    throw new RangeError(
      `buildAmountDiscloseProof: amount must be in [0, 2^64), got ${input.amount}`
    );
  }
  if (input.blinding < 0n || input.blinding >= 1n << 128n) {
    throw new RangeError(
      `buildAmountDiscloseProof: blinding must be in [0, 2^128), got ${input.blinding}`
    );
  }

  const commitment = await computeCommitment(input.amount, input.blinding);

  const snarkjs = await import("snarkjs");
  const circuitInput = {
    blinding: input.blinding.toString(),
    claimed_amount: input.amount.toString(),
    commit: [commitment.x.toString(), commitment.y.toString()],
  };

  const { proof, publicSignals } = (await snarkjs.groth16.fullProve(
    circuitInput,
    wasmPath,
    zkeyPath
  )) as { proof: SnarkJSProof; publicSignals: string[] };

  if (publicSignals.length !== 3) {
    throw new Error(
      `buildAmountDiscloseProof: expected 3 public signals, got ${publicSignals.length}`
    );
  }

  const evmProof = applyPiBSwap(proof);
  const proofUint256 = evmProofToUint256Array(evmProof);

  const publicInputs: readonly [bigint, bigint, bigint] = [
    BigInt(publicSignals[0]),
    BigInt(publicSignals[1]),
    BigInt(publicSignals[2]),
  ];

  return {
    commitment,
    txCommit: [commitment.x, commitment.y] as const,
    proof: proofUint256,
    publicInputs,
    rawProof: proof,
    rawPublicSignals: publicSignals,
  };
}
