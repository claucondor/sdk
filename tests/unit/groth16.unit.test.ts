/**
 * Unit tests for Groth16 SDK utilities — no network required.
 *
 * Tests:
 *  - proofToEVMFormat: pi_b Fp2 swap is correctly applied
 *  - parsePublicSignals: correct field mapping
 *  - pubSignalsToArray: correct array order
 */

import { describe, it, expect } from "vitest";
import {
  proofToEVMFormat,
  parsePublicSignals,
  pubSignalsToArray,
  VERIFIER_ADDRESS,
  VERIFY_PROOF_SELECTOR,
} from "../../src/primitives/groth16";
import type { SnarkJSProof } from "../../src/primitives/groth16";

// ---------------------------------------------------------------------------
// Sample snarkJS proof structure (values fabricated — unit tests check shape)
// ---------------------------------------------------------------------------

const SAMPLE_PROOF: SnarkJSProof = {
  pi_a: [
    "11111111111111111111111111111111111111111111111111111111111111111",
    "22222222222222222222222222222222222222222222222222222222222222222",
    "1",
  ],
  pi_b: [
    [
      "33333333333333333333333333333333333333333333333333333333333333333",
      "44444444444444444444444444444444444444444444444444444444444444444",
    ],
    [
      "55555555555555555555555555555555555555555555555555555555555555555",
      "66666666666666666666666666666666666666666666666666666666666666666",
    ],
    ["1", "0"],
  ],
  pi_c: [
    "77777777777777777777777777777777777777777777777777777777777777777",
    "88888888888888888888888888888888888888888888888888888888888888888",
    "1",
  ],
  protocol: "groth16",
  curve: "bn128",
};

const SAMPLE_SIGNALS = [
  "100000000000000000000000000000000000000000000000000000000000001",
  "200000000000000000000000000000000000000000000000000000000000002",
  "300000000000000000000000000000000000000000000000000000000000003",
  "400000000000000000000000000000000000000000000000000000000000004",
  "500000000000000000000000000000000000000000000000000000000000005",
  "600000000000000000000000000000000000000000000000000000000000006",
];

// ---------------------------------------------------------------------------
// proofToEVMFormat (pi_b swap)
// ---------------------------------------------------------------------------

describe("proofToEVMFormat", () => {
  it("pA matches pi_a[0] and pi_a[1]", () => {
    const evm = proofToEVMFormat(SAMPLE_PROOF);
    expect(evm.pA[0]).toBe(BigInt(SAMPLE_PROOF.pi_a[0]));
    expect(evm.pA[1]).toBe(BigInt(SAMPLE_PROOF.pi_a[1]));
  });

  it("pC matches pi_c[0] and pi_c[1]", () => {
    const evm = proofToEVMFormat(SAMPLE_PROOF);
    expect(evm.pC[0]).toBe(BigInt(SAMPLE_PROOF.pi_c[0]));
    expect(evm.pC[1]).toBe(BigInt(SAMPLE_PROOF.pi_c[1]));
  });

  it("pB[0] is Fp2-swapped: [pi_b[0][1], pi_b[0][0]]", () => {
    const evm = proofToEVMFormat(SAMPLE_PROOF);
    // EIP-197: im first, then re
    expect(evm.pB[0][0]).toBe(BigInt(SAMPLE_PROOF.pi_b[0][1])); // im
    expect(evm.pB[0][1]).toBe(BigInt(SAMPLE_PROOF.pi_b[0][0])); // re
  });

  it("pB[1] is Fp2-swapped: [pi_b[1][1], pi_b[1][0]]", () => {
    const evm = proofToEVMFormat(SAMPLE_PROOF);
    expect(evm.pB[1][0]).toBe(BigInt(SAMPLE_PROOF.pi_b[1][1])); // im
    expect(evm.pB[1][1]).toBe(BigInt(SAMPLE_PROOF.pi_b[1][0])); // re
  });

  it("all values are BigInt", () => {
    const evm = proofToEVMFormat(SAMPLE_PROOF);
    expect(typeof evm.pA[0]).toBe("bigint");
    expect(typeof evm.pA[1]).toBe("bigint");
    expect(typeof evm.pB[0][0]).toBe("bigint");
    expect(typeof evm.pB[0][1]).toBe("bigint");
    expect(typeof evm.pB[1][0]).toBe("bigint");
    expect(typeof evm.pB[1][1]).toBe("bigint");
    expect(typeof evm.pC[0]).toBe("bigint");
    expect(typeof evm.pC[1]).toBe("bigint");
  });
});

// ---------------------------------------------------------------------------
// parsePublicSignals
// ---------------------------------------------------------------------------

describe("parsePublicSignals", () => {
  it("parses 6 signals into the correct fields", () => {
    const signals = parsePublicSignals(SAMPLE_SIGNALS);
    expect(signals.oldCommitX).toBe(BigInt(SAMPLE_SIGNALS[0]));
    expect(signals.oldCommitY).toBe(BigInt(SAMPLE_SIGNALS[1]));
    expect(signals.transferCommitX).toBe(BigInt(SAMPLE_SIGNALS[2]));
    expect(signals.transferCommitY).toBe(BigInt(SAMPLE_SIGNALS[3]));
    expect(signals.newCommitX).toBe(BigInt(SAMPLE_SIGNALS[4]));
    expect(signals.newCommitY).toBe(BigInt(SAMPLE_SIGNALS[5]));
  });

  it("throws if fewer than 6 signals provided", () => {
    expect(() => parsePublicSignals(SAMPLE_SIGNALS.slice(0, 5))).toThrow(
      "expected 6 signals"
    );
  });

  it("throws if more than 6 signals provided", () => {
    expect(() =>
      parsePublicSignals([...SAMPLE_SIGNALS, "7"])
    ).toThrow("expected 6 signals");
  });
});

// ---------------------------------------------------------------------------
// pubSignalsToArray
// ---------------------------------------------------------------------------

describe("pubSignalsToArray", () => {
  it("produces the same array that parsePublicSignals consumed", () => {
    const parsed = parsePublicSignals(SAMPLE_SIGNALS);
    const arr = pubSignalsToArray(parsed);

    expect(arr.length).toBe(6);
    expect(arr[0]).toBe(BigInt(SAMPLE_SIGNALS[0]));
    expect(arr[1]).toBe(BigInt(SAMPLE_SIGNALS[1]));
    expect(arr[2]).toBe(BigInt(SAMPLE_SIGNALS[2]));
    expect(arr[3]).toBe(BigInt(SAMPLE_SIGNALS[3]));
    expect(arr[4]).toBe(BigInt(SAMPLE_SIGNALS[4]));
    expect(arr[5]).toBe(BigInt(SAMPLE_SIGNALS[5]));
  });

  it("round-trip: parse then serialize produces identical order", () => {
    const parsed = parsePublicSignals(SAMPLE_SIGNALS);
    const arr = pubSignalsToArray(parsed);
    for (let i = 0; i < 6; i++) {
      expect(arr[i]).toBe(BigInt(SAMPLE_SIGNALS[i]));
    }
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("VERIFIER_ADDRESS is a valid EVM address", () => {
    expect(VERIFIER_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("VERIFY_PROOF_SELECTOR is 4 bytes", () => {
    expect(VERIFY_PROOF_SELECTOR).toMatch(/^0x[0-9a-fA-F]{8}$/);
  });
});
