/**
 * tests/unit/proof/batch-claim.test.ts
 *
 * Unit tests for the batch-claim proof builder.
 * Does NOT run groth16.fullProve (too slow for unit tests; wasm/zkey not bundled).
 *
 * Tests:
 *   1. C_old computation matches expected (from happy-path.json fixture)
 *   2. C_consumed accumulation correctness (chained babyAdd, N=50)
 *   3. Zero-padding is identity (padded notes don't change C_consumed)
 *   4. newBalance computation
 *   5. buildBatchClaimProof formats proof correctly (mocked snarkjs)
 *   6. buildBatchClaimProof applies pB Fp2 swap
 *   7. buildBatchClaimProof throws on wrong public signal count
 *
 * Fixture values from:
 *   circuits/aggregate-claim-batch/inputs/happy-path.json (n5 entry)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeCommitment, addCommitmentsLocal } from "../../../src/primitives/pedersen";

// ---------------------------------------------------------------------------
// Mock snarkjs at module level so it intercepts the dynamic import inside
// buildBatchClaimProof. vi.mock is hoisted before all imports.
// ---------------------------------------------------------------------------

vi.mock("snarkjs", () => ({
  groth16: {
    fullProve: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Fixture values from happy-path.json (n5)
// ---------------------------------------------------------------------------

const FIXTURE = {
  oldBalance: 1_000_000n,
  oldBlinding: 111_111_111_111_111_111n,
  newBlinding: 999_999_999_999_999_999n,
  // 5 real notes, 45 zero-padded in circuit
  amounts: [7001n, 14001n, 21001n, 28001n, 35001n],
  blindings: [
    260_000_000_183n,
    390_000_000_274n,
    520_000_000_365n,
    650_000_000_456n,
    780_000_000_547n,
  ],
  // Expected commitment coordinates from proof-inputs.cjs (verified against circuit output)
  C_old_x: 8493995088669492941030449993460966168125164062547959036539380137995121652823n,
  C_old_y: 980091792878496942390948583639228336197310148012141975928130766742690741129n,
  C_new_x: 10136366868494787981631135992376279633230776698842331932391551007707568304977n,
  C_new_y: 3047412401573570226833251737192551019877468074472798567184802764578354556335n,
  C_consumed_x: 136933251170279916227381655360309977121529027810286637389835077920485947039n,
  C_consumed_y: 20836619934082269279304708433730610952589712728197645352270072933360614163082n,
};

/** 6 public signals matching fixture C_old/C_new/C_consumed. */
const FIXTURE_PUBLIC_SIGNALS = [
  FIXTURE.C_old_x.toString(),
  FIXTURE.C_old_y.toString(),
  FIXTURE.C_new_x.toString(),
  FIXTURE.C_new_y.toString(),
  FIXTURE.C_consumed_x.toString(),
  FIXTURE.C_consumed_y.toString(),
];

/** Minimal mock snarkjs proof (pi_b values chosen for easy Fp2-swap verification). */
const MOCK_SNARKJS_PROOF = {
  pi_a: ["10", "20", "1"],
  pi_b: [["30", "40"], ["50", "60"], ["1", "1"]],
  pi_c: ["70", "80", "1"],
  protocol: "groth16",
  curve: "bn128",
};

// ---------------------------------------------------------------------------
// Helper: set snarkjs mock return value
// ---------------------------------------------------------------------------

async function setSnarkjsMock(
  publicSignals: string[] = FIXTURE_PUBLIC_SIGNALS,
  proof = MOCK_SNARKJS_PROOF
) {
  const snarkjs = await import("snarkjs");
  vi.mocked(snarkjs.groth16.fullProve).mockResolvedValue({ proof, publicSignals } as never);
}

// ---------------------------------------------------------------------------
// Part 1 — Pedersen commitment arithmetic (no snarkjs involved)
// ---------------------------------------------------------------------------

describe("proof/batch-claim — commitment arithmetic", () => {
  describe("C_old computation", () => {
    it("matches the happy-path fixture C_old", async () => {
      const C_old = await computeCommitment(FIXTURE.oldBalance, FIXTURE.oldBlinding);
      expect(C_old.x).toBe(FIXTURE.C_old_x);
      expect(C_old.y).toBe(FIXTURE.C_old_y);
    });
  });

  describe("newBalance computation", () => {
    it("equals oldBalance + Σ amounts", () => {
      const sumAmounts = FIXTURE.amounts.reduce((acc, a) => acc + a, 0n);
      const newBalance = FIXTURE.oldBalance + sumAmounts;
      expect(newBalance).toBe(1_105_005n);
    });
  });

  describe("C_new computation", () => {
    it("matches the happy-path fixture C_new", async () => {
      const sumAmounts = FIXTURE.amounts.reduce((acc, a) => acc + a, 0n);
      const newBalance = FIXTURE.oldBalance + sumAmounts;
      const C_new = await computeCommitment(newBalance, FIXTURE.newBlinding);
      expect(C_new.x).toBe(FIXTURE.C_new_x);
      expect(C_new.y).toBe(FIXTURE.C_new_y);
    });
  });

  describe("C_consumed accumulation (chained babyAdd, N=50)", () => {
    it("matches the happy-path fixture C_consumed with 45 zero-padded notes", async () => {
      const paddedAmounts = [...FIXTURE.amounts];
      const paddedBlindings = [...FIXTURE.blindings];
      while (paddedAmounts.length < 50) {
        paddedAmounts.push(0n);
        paddedBlindings.push(0n);
      }

      let C_consumed = { x: 0n, y: 1n }; // identity
      for (let i = 0; i < 50; i++) {
        const noteCommit = await computeCommitment(paddedAmounts[i], paddedBlindings[i]);
        C_consumed = await addCommitmentsLocal(C_consumed, noteCommit);
      }

      expect(C_consumed.x).toBe(FIXTURE.C_consumed_x);
      expect(C_consumed.y).toBe(FIXTURE.C_consumed_y);
    });

    it("adding Commit(0, 0) = identity (zero-padding is a no-op)", async () => {
      const zeroCommit = await computeCommitment(0n, 0n);
      const somePoint = { x: FIXTURE.C_old_x, y: FIXTURE.C_old_y };
      const result = await addCommitmentsLocal(somePoint, zeroCommit);
      expect(result.x).toBe(somePoint.x);
      expect(result.y).toBe(somePoint.y);
    });

    it("N=50 with 45 zeros equals accumulation over only real notes (homomorphism)", async () => {
      const padded = [...FIXTURE.amounts];
      const paddedB = [...FIXTURE.blindings];
      while (padded.length < 50) { padded.push(0n); paddedB.push(0n); }

      let cFull = { x: 0n, y: 1n };
      for (let i = 0; i < 50; i++) {
        cFull = await addCommitmentsLocal(cFull, await computeCommitment(padded[i], paddedB[i]));
      }

      let cSparse = { x: 0n, y: 1n };
      for (let i = 0; i < FIXTURE.amounts.length; i++) {
        cSparse = await addCommitmentsLocal(cSparse, await computeCommitment(FIXTURE.amounts[i], FIXTURE.blindings[i]));
      }

      expect(cFull.x).toBe(cSparse.x);
      expect(cFull.y).toBe(cSparse.y);
    });
  });
});

// ---------------------------------------------------------------------------
// Part 2 — buildBatchClaimProof (snarkjs mocked)
// ---------------------------------------------------------------------------

describe("buildBatchClaimProof (mocked snarkjs)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setSnarkjsMock();
  });

  it("returns a 6-element publicInputs and 8-element proof", async () => {
    const { buildBatchClaimProof } = await import("../../../src/proof/batch-claim");

    const result = await buildBatchClaimProof(
      {
        oldBalance: FIXTURE.oldBalance,
        oldBlinding: FIXTURE.oldBlinding,
        newBlinding: FIXTURE.newBlinding,
        notes: FIXTURE.amounts.map((amount, i) => ({
          amount,
          blinding: FIXTURE.blindings[i],
        })),
      },
      { wasmPath: "/fake/path.wasm", zkeyPath: "/fake/path.zkey" }
    );

    expect(result.publicInputs).toHaveLength(6);
    expect(result.proof).toHaveLength(8);
    for (const v of result.publicInputs) expect(typeof v).toBe("bigint");
    for (const v of result.proof) expect(typeof v).toBe("bigint");
  });

  it("publicInputs match the 6 public signals from snarkjs", async () => {
    const { buildBatchClaimProof } = await import("../../../src/proof/batch-claim");

    const result = await buildBatchClaimProof(
      {
        oldBalance: FIXTURE.oldBalance,
        oldBlinding: FIXTURE.oldBlinding,
        newBlinding: FIXTURE.newBlinding,
        notes: FIXTURE.amounts.map((amount, i) => ({
          amount,
          blinding: FIXTURE.blindings[i],
        })),
      },
      { wasmPath: "/fake/path.wasm", zkeyPath: "/fake/path.zkey" }
    );

    expect(result.publicInputs[0]).toBe(FIXTURE.C_old_x);
    expect(result.publicInputs[1]).toBe(FIXTURE.C_old_y);
    expect(result.publicInputs[2]).toBe(FIXTURE.C_new_x);
    expect(result.publicInputs[3]).toBe(FIXTURE.C_new_y);
    expect(result.publicInputs[4]).toBe(FIXTURE.C_consumed_x);
    expect(result.publicInputs[5]).toBe(FIXTURE.C_consumed_y);
  });

  it("newBalance equals oldBalance + Σ amounts", async () => {
    const { buildBatchClaimProof } = await import("../../../src/proof/batch-claim");

    const result = await buildBatchClaimProof(
      {
        oldBalance: FIXTURE.oldBalance,
        oldBlinding: FIXTURE.oldBlinding,
        newBlinding: FIXTURE.newBlinding,
        notes: FIXTURE.amounts.map((amount, i) => ({
          amount,
          blinding: FIXTURE.blindings[i],
        })),
      },
      { wasmPath: "/fake/path.wasm", zkeyPath: "/fake/path.zkey" }
    );

    const expected = FIXTURE.oldBalance + FIXTURE.amounts.reduce((a, b) => a + b, 0n);
    expect(result.newBalance).toBe(expected);
  });

  it("applies pB Fp2 swap (proof[2]=im, proof[3]=re of pi_b[0])", async () => {
    const { buildBatchClaimProof } = await import("../../../src/proof/batch-claim");

    const result = await buildBatchClaimProof(
      {
        oldBalance: FIXTURE.oldBalance,
        oldBlinding: FIXTURE.oldBlinding,
        newBlinding: FIXTURE.newBlinding,
        notes: [],
      },
      { wasmPath: "/fake/path.wasm", zkeyPath: "/fake/path.zkey" }
    );

    // MOCK_SNARKJS_PROOF.pi_b[0] = ["30","40"]  (re=30, im=40)
    // After Fp2 swap: EVM pB[0] = [40n, 30n]
    // flat proof[2] = pB[0][0] = 40n, proof[3] = pB[0][1] = 30n
    expect(result.proof[0]).toBe(10n); // pA[0]
    expect(result.proof[1]).toBe(20n); // pA[1]
    expect(result.proof[2]).toBe(40n); // pB_EVM[0][0] = im of pi_b[0]
    expect(result.proof[3]).toBe(30n); // pB_EVM[0][1] = re of pi_b[0]
    expect(result.proof[4]).toBe(60n); // pB_EVM[1][0] = im of pi_b[1]
    expect(result.proof[5]).toBe(50n); // pB_EVM[1][1] = re of pi_b[1]
    expect(result.proof[6]).toBe(70n); // pC[0]
    expect(result.proof[7]).toBe(80n); // pC[1]
  });

  it("throws if snarkjs returns wrong number of public signals", async () => {
    const snarkjs = await import("snarkjs");
    vi.mocked(snarkjs.groth16.fullProve).mockResolvedValue({
      proof: MOCK_SNARKJS_PROOF,
      publicSignals: ["1", "2", "3"], // Wrong — only 3
    } as never);

    const { buildBatchClaimProof } = await import("../../../src/proof/batch-claim");
    await expect(
      buildBatchClaimProof(
        { oldBalance: 1n, oldBlinding: 1n, newBlinding: 1n, notes: [] },
        { wasmPath: "/fake/path.wasm", zkeyPath: "/fake/path.zkey" }
      )
    ).rejects.toThrow(/expected 6 public signals/);
  });

  it("accepts empty notes array (pads to 50 zeros)", async () => {
    const { buildBatchClaimProof } = await import("../../../src/proof/batch-claim");
    const snarkjs = await import("snarkjs");

    await buildBatchClaimProof(
      {
        oldBalance: FIXTURE.oldBalance,
        oldBlinding: FIXTURE.oldBlinding,
        newBlinding: FIXTURE.newBlinding,
        notes: [],
      },
      { wasmPath: "/fake/path.wasm", zkeyPath: "/fake/path.zkey" }
    );

    const call = vi.mocked(snarkjs.groth16.fullProve).mock.calls[0];
    const circuitInput = call[0] as Record<string, unknown>;
    // amounts and blindings should be 50 elements of "0"
    expect((circuitInput.amounts as string[]).length).toBe(50);
    expect((circuitInput.blindings as string[]).every((v: string) => v === "0")).toBe(true);
  });

  it("truncates notes to 50 when more are supplied", async () => {
    const { buildBatchClaimProof } = await import("../../../src/proof/batch-claim");
    const snarkjs = await import("snarkjs");

    const manyNotes = Array.from({ length: 60 }, (_, i) => ({
      amount: BigInt(i + 1),
      blinding: BigInt(i + 1),
    }));

    await buildBatchClaimProof(
      {
        oldBalance: FIXTURE.oldBalance,
        oldBlinding: FIXTURE.oldBlinding,
        newBlinding: FIXTURE.newBlinding,
        notes: manyNotes,
      },
      { wasmPath: "/fake/path.wasm", zkeyPath: "/fake/path.zkey" }
    );

    const call = vi.mocked(snarkjs.groth16.fullProve).mock.calls[0];
    const circuitInput = call[0] as Record<string, unknown>;
    expect((circuitInput.amounts as string[]).length).toBe(50);
  });
});
