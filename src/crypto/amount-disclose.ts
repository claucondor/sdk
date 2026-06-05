/**
 * crypto/amount-disclose.ts — buildAmountDiscloseProof
 *
 * Wraps the aggregate AmountDisclose Groth16 circuit. Proves that a 2-gen
 * Pedersen commitment C = [amount]·G + [blinding]·H binds to a PUBLIC amount,
 * used by JanusToken.wrapWithProof (and one of the two proofs for unwrap).
 *
 * Circuit (amount_disclose_aggregate.circom):
 *   private inputs: blinding (252-bit scalar)
 *   public inputs : [amount, commitX, commitY, nonce]
 *   asserts       : commit == [amount]·G + [blinding]·H
 *                   amount  in [0, 2^128)
 *                   blinding in [0, 2^252)
 *                   nonce bound into witness (anti-replay via contract storage)
 *
 * Public input layout (Solidity verifier call order):
 *   [0] amount
 *   [1] commitX
 *   [2] commitY
 *   [3] nonce
 */

import { applyPiBSwap, evmProofToUint256Array } from "../utils/pi-b-swap.js";
import { computeCommitment } from "../primitives/pedersen.js";
import type { Point } from "../types/commitment.js";
import type { SnarkJSProof, ProofUint256 } from "../types/proof.js";

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
    wasm: resolve(PACKAGE_ROOT, "circuits/aggregate/amount_disclose_aggregate.wasm"),
    zkey: resolve(PACKAGE_ROOT, "circuits/aggregate/amount_disclose_aggregate_test.zkey"),
  };
  return _circuitPaths;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AmountDiscloseProofInput {
  /** Cleartext amount being bound to the commitment (in [0, 2^128)). */
  amount: bigint;
  /** 252-bit Pedersen blinding scalar (in [0, SUBORDER)) — keep private. */
  blinding: bigint;
  /** Anti-replay nonce for this wrap (enforced by contract usedNonces mapping). */
  nonce: bigint;
}

export interface AmountDiscloseProofResult {
  /** 2-gen Pedersen commitment of (amount, blinding). */
  commitment: Point;
  /** Convenience [Cx, Cy] tuple to splat into wrap/unwrap calls. */
  txCommit: readonly [bigint, bigint];
  /** Groth16 proof as uint256[8] (pi_b Fp2-swapped — EVM-ready). */
  proof: ProofUint256;
  /**
   * Public inputs [amount, Cx, Cy, nonce] as bigint[4].
   * Note: layout changed from v0.6 [amount, Cx, Cy] (3 signals) to 4 signals.
   */
  publicInputs: readonly [bigint, bigint, bigint, bigint];
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
 * Generate the aggregate AmountDisclose Groth16 proof.
 *
 * Off-chain, we compute the 2-gen Pedersen commitment of (amount, blinding) and
 * feed it as a public input to the circuit along with the nonce. The on-chain
 * verifier checks that the supplied commit matches the 2-gen Pedersen computation.
 *
 * Use this proof for JanusToken.wrapWithProof (amount = msg.value / transfer amount)
 * and for the amount-disclose half of JanusToken.unwrap.
 *
 * @param input    { amount, blinding, nonce }
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

  if (input.amount < 0n || input.amount >= 1n << 128n) {
    throw new RangeError(
      `buildAmountDiscloseProof: amount must be in [0, 2^128), got ${input.amount}`
    );
  }
  // 252-bit blinding constraint (matches circuit's Num2Bits(252))
  const MAX_BLINDING = (1n << 252n) - 1n;
  if (input.blinding < 0n || input.blinding > MAX_BLINDING) {
    throw new RangeError(
      `buildAmountDiscloseProof: blinding must be in [0, 2^252), got ${input.blinding}`
    );
  }
  if (input.nonce < 0n) {
    throw new RangeError(
      `buildAmountDiscloseProof: nonce must be >= 0, got ${input.nonce}`
    );
  }

  const commitment = await computeCommitment(input.amount, input.blinding);

  const snarkjs = await import("snarkjs");
  const circuitInput = {
    blinding: input.blinding.toString(),
    amount: input.amount.toString(),
    commitX: commitment.x.toString(),
    commitY: commitment.y.toString(),
    nonce: input.nonce.toString(),
  };

  const { proof, publicSignals } = (await snarkjs.groth16.fullProve(
    circuitInput,
    wasmPath,
    zkeyPath
  )) as { proof: SnarkJSProof; publicSignals: string[] };

  if (publicSignals.length !== 4) {
    throw new Error(
      `buildAmountDiscloseProof: expected 4 public signals, got ${publicSignals.length}`
    );
  }

  const evmProof = applyPiBSwap(proof);
  const proofUint256 = evmProofToUint256Array(evmProof);

  const publicInputs: readonly [bigint, bigint, bigint, bigint] = [
    BigInt(publicSignals[0]),
    BigInt(publicSignals[1]),
    BigInt(publicSignals[2]),
    BigInt(publicSignals[3]),
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
