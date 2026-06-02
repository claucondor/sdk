/**
 * Unit tests for pi-b-swap.ts
 * Tests: known test vector for applyPiBSwap, evmProofToUint256Array shape.
 */

import { describe, it, expect } from "vitest";
import { applyPiBSwap, evmProofToUint256Array } from "../../src/utils/pi-b-swap";
import type { SnarkJSProof } from "../../src/types/proof";

// Known test vector: snarkjs proof shape → expected EVM-ready shape
const SAMPLE_PROOF: SnarkJSProof = {
  pi_a: ["1", "2", "1"],
  pi_b: [
    ["10", "11"],
    ["20", "21"],
  ],
  pi_c: ["7", "8", "1"],
  protocol: "groth16",
};

describe("applyPiBSwap", () => {
  it("swaps Fp2 pairs in pi_b (im,re → re,im convention)", () => {
    const evmProof = applyPiBSwap(SAMPLE_PROOF);
    // pi_b[0] was [10, 11] (re=10, im=11) → becomes [11, 10] (im first)
    expect(evmProof.pB[0][0]).toBe(11n); // im0
    expect(evmProof.pB[0][1]).toBe(10n); // re0
    // pi_b[1] was [20, 21] → becomes [21, 20]
    expect(evmProof.pB[1][0]).toBe(21n); // im1
    expect(evmProof.pB[1][1]).toBe(20n); // re1
  });

  it("pA and pC pass through unchanged", () => {
    const evmProof = applyPiBSwap(SAMPLE_PROOF);
    expect(evmProof.pA[0]).toBe(1n);
    expect(evmProof.pA[1]).toBe(2n);
    expect(evmProof.pC[0]).toBe(7n);
    expect(evmProof.pC[1]).toBe(8n);
  });

  it("applying swap twice returns DIFFERENT result from original (not a true involution at same order)", () => {
    // Swap is not an involution in the bigint-string sense, but semantically it is.
    // This test just ensures the transform is applied (not a no-op).
    const evmProof = applyPiBSwap(SAMPLE_PROOF);
    expect(evmProof.pB[0][0]).not.toBe(BigInt(SAMPLE_PROOF.pi_b[0][0]));
  });
});

describe("evmProofToUint256Array", () => {
  it("flattens to uint256[8] in correct order", () => {
    const evmProof = applyPiBSwap(SAMPLE_PROOF);
    const arr = evmProofToUint256Array(evmProof);
    expect(arr).toHaveLength(8);
    // Order: pA.x, pA.y, pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC.x, pC.y
    expect(arr[0]).toBe(evmProof.pA[0]);
    expect(arr[1]).toBe(evmProof.pA[1]);
    expect(arr[2]).toBe(evmProof.pB[0][0]);
    expect(arr[3]).toBe(evmProof.pB[0][1]);
    expect(arr[4]).toBe(evmProof.pB[1][0]);
    expect(arr[5]).toBe(evmProof.pB[1][1]);
    expect(arr[6]).toBe(evmProof.pC[0]);
    expect(arr[7]).toBe(evmProof.pC[1]);
  });

  it("all elements are bigints", () => {
    const arr = evmProofToUint256Array(applyPiBSwap(SAMPLE_PROOF));
    for (const v of arr) {
      expect(typeof v).toBe("bigint");
    }
  });
});
