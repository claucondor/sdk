/**
 * Unit tests for utility functions — no network required.
 *
 * Tests hex conversion, pi_b swap utilities.
 */

import { describe, it, expect } from "vitest";
import { bigintToHex, hexToBigint, padHex, decimalToBigint } from "../../src/utils/hex";
import { applyPiBSwap, evmProofToUint256Array } from "../../src/utils/pi-b-swap";
import type { SnarkJSProof } from "../../src/types/proof";

// ---------------------------------------------------------------------------
// hex utilities
// ---------------------------------------------------------------------------

describe("bigintToHex", () => {
  it("converts 0n to 32-byte zero", () => {
    expect(bigintToHex(0n)).toBe("0x" + "0".repeat(64));
  });

  it("converts 255n to 0xff padded to 32 bytes", () => {
    expect(bigintToHex(255n)).toBe("0x" + "0".repeat(62) + "ff");
  });

  it("pads to specified byte count", () => {
    expect(bigintToHex(255n, 1)).toBe("0xff");
    expect(bigintToHex(255n, 2)).toBe("0x00ff");
  });

  it("throws on negative input", () => {
    expect(() => bigintToHex(-1n)).toThrow(RangeError);
  });
});

describe("hexToBigint", () => {
  it("converts 0x00 to 0n", () => {
    expect(hexToBigint("0x00")).toBe(0n);
  });

  it("converts 0xff to 255n", () => {
    expect(hexToBigint("0xff")).toBe(255n);
  });

  it("handles strings without 0x prefix", () => {
    expect(hexToBigint("ff")).toBe(255n);
  });

  it("is inverse of bigintToHex", () => {
    const n = 12345678901234567890n;
    expect(hexToBigint(bigintToHex(n))).toBe(n);
  });
});

describe("padHex", () => {
  it("pads a short hex to 32 bytes", () => {
    const padded = padHex("0xff", 32);
    expect(padded.length).toBe(2 + 64); // 0x + 64 hex chars
    expect(padded.endsWith("ff")).toBe(true);
    expect(padded.startsWith("0x" + "0".repeat(62))).toBe(true);
  });

  it("handles strings without 0x prefix", () => {
    expect(padHex("ff", 1)).toBe("0xff");
  });
});

describe("decimalToBigint", () => {
  it("converts decimal string to bigint", () => {
    expect(decimalToBigint("12345")).toBe(12345n);
  });

  it("converts hex string to bigint", () => {
    expect(decimalToBigint("0xff")).toBe(255n);
  });
});

// ---------------------------------------------------------------------------
// pi_b swap
// ---------------------------------------------------------------------------

const SAMPLE_PROOF: SnarkJSProof = {
  pi_a: ["111", "222", "1"],
  pi_b: [
    ["333", "444"],
    ["555", "666"],
    ["1", "0"],
  ],
  pi_c: ["777", "888", "1"],
  protocol: "groth16",
  curve: "bn128",
};

describe("applyPiBSwap", () => {
  it("swaps pi_b[0]: [re, im] → [im, re]", () => {
    const evm = applyPiBSwap(SAMPLE_PROOF);
    expect(evm.pB[0][0]).toBe(BigInt("444")); // was im at index [1]
    expect(evm.pB[0][1]).toBe(BigInt("333")); // was re at index [0]
  });

  it("swaps pi_b[1]: [re, im] → [im, re]", () => {
    const evm = applyPiBSwap(SAMPLE_PROOF);
    expect(evm.pB[1][0]).toBe(BigInt("666")); // was im at index [1]
    expect(evm.pB[1][1]).toBe(BigInt("555")); // was re at index [0]
  });

  it("pA and pC are unchanged in value, converted to bigint", () => {
    const evm = applyPiBSwap(SAMPLE_PROOF);
    expect(evm.pA[0]).toBe(111n);
    expect(evm.pA[1]).toBe(222n);
    expect(evm.pC[0]).toBe(777n);
    expect(evm.pC[1]).toBe(888n);
  });
});

describe("evmProofToUint256Array", () => {
  it("flattens to 8 elements in the correct order", () => {
    const evm = applyPiBSwap(SAMPLE_PROOF);
    const arr = evmProofToUint256Array(evm);
    expect(arr.length).toBe(8);
    // [pA.x, pA.y, pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC.x, pC.y]
    expect(arr[0]).toBe(evm.pA[0]);
    expect(arr[1]).toBe(evm.pA[1]);
    expect(arr[2]).toBe(evm.pB[0][0]);
    expect(arr[3]).toBe(evm.pB[0][1]);
    expect(arr[4]).toBe(evm.pB[1][0]);
    expect(arr[5]).toBe(evm.pB[1][1]);
    expect(arr[6]).toBe(evm.pC[0]);
    expect(arr[7]).toBe(evm.pC[1]);
  });

  it("all elements are bigint", () => {
    const arr = evmProofToUint256Array(applyPiBSwap(SAMPLE_PROOF));
    for (const v of arr) {
      expect(typeof v).toBe("bigint");
    }
  });
});
