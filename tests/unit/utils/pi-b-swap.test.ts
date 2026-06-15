/**
 * tests/unit/utils/pi-b-swap.test.ts
 *
 * Verify the Groth16 pB Fp2-swap utility used to convert snarkjs proof format to EVM order.
 */
import { describe, it, expect } from "vitest";
import { applyPiBSwap, evmProofToUint256Array } from "../../../src/utils/pi-b-swap";

describe("utils/pi-b-swap", () => {
  // Minimal mock Groth16 proof in snarkjs JSON format
  const mockSnarkJSProof = {
    pi_a: ["1", "2", "3"],
    pi_b: [["3", "4"], ["5", "6"], ["7", "8"]],
    pi_c: ["9", "10", "11"],
    protocol: "groth16",
    curve: "bn128",
  };

  it("applyPiBSwap swaps each Fp2 coefficient pair in pi_b", () => {
    const evmProof = applyPiBSwap(mockSnarkJSProof);

    // snarkjs: pi_b[0] = ["3","4"] (re=3, im=4)
    // EVM:     pB[0]   = [4n, 3n]  (im first = 4, re second = 3)
    expect(evmProof.pB[0]).toEqual([4n, 3n]);

    // snarkjs: pi_b[1] = ["5","6"] (re=5, im=6)
    // EVM:     pB[1]   = [6n, 5n]
    expect(evmProof.pB[1]).toEqual([6n, 5n]);

    // pA and pC are unchanged (converted to bigint)
    expect(evmProof.pA).toEqual([1n, 2n]);
    expect(evmProof.pC).toEqual([9n, 10n]);
  });

  it("applyPiBSwap is its own inverse (double-swap == identity)", () => {
    const swapped = applyPiBSwap(mockSnarkJSProof);
    // Re-pack swapped as a SnarkJS-format proof for second swap
    const repack = {
      ...mockSnarkJSProof,
      pi_b: [
        [swapped.pB[0][0].toString(), swapped.pB[0][1].toString()],
        [swapped.pB[1][0].toString(), swapped.pB[1][1].toString()],
        ["7", "8"],
      ],
    };
    const restored = applyPiBSwap(repack);

    // pB[0] should be back to original [3n, 4n]? No — original was (re=3,im=4) → evm=(im=4,re=3)
    // Double swap: (re=3,im=4) → evm=(4,3) → re-swap:(3,4) — NOT an identity in the general sense.
    // The point is that the EVM serialization is the canonical form.
    // Instead verify: applyPiBSwap(applyPiBSwap-as-snarkjs) = original
    expect(restored.pB[0][0]).toBe(3n); // 3 = original re
    expect(restored.pB[0][1]).toBe(4n); // 4 = original im
  });

  it("evmProofToUint256Array produces exactly 8 bigints in correct order", () => {
    const evmProof = applyPiBSwap(mockSnarkJSProof);
    const arr = evmProofToUint256Array(evmProof);

    expect(arr).toHaveLength(8);
    expect(arr.every(v => typeof v === "bigint")).toBe(true);

    // Layout: pA[0], pA[1], pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC[0], pC[1]
    expect(arr[0]).toBe(1n); // pA[0]
    expect(arr[1]).toBe(2n); // pA[1]
    expect(arr[2]).toBe(4n); // pB[0][0] = swapped im
    expect(arr[3]).toBe(3n); // pB[0][1] = swapped re
    expect(arr[4]).toBe(6n); // pB[1][0] = swapped im
    expect(arr[5]).toBe(5n); // pB[1][1] = swapped re
    expect(arr[6]).toBe(9n); // pC[0]
    expect(arr[7]).toBe(10n); // pC[1]
  });
});
