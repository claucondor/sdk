/**
 * Unit tests for Pedersen commitment operations — no network required.
 *
 * v0.7: computeCommitment uses 2-gen Pedersen ([v]·G + [r]·H).
 * Value range: [0, 2^128); blinding range: [0, SUBORDER).
 *
 * Tests computeCommitment, addCommitmentsLocal, negateCommitment,
 * identityCommitment, and isIdentityCommitment.
 */

import { describe, it, expect } from "vitest";
import {
  computeCommitment,
  addCommitmentsLocal,
  negateCommitment,
  identityCommitment,
  isIdentityCommitment,
} from "../../src/primitives/pedersen";
import { CURVE_P } from "../../src/types/commitment";
import { SUBORDER } from "@openjanus/commitment";

describe("computeCommitment (2-gen Pedersen)", () => {
  it("returns a BabyJubJub field element (x, y < P)", async () => {
    const c = await computeCommitment(100n, 999n);
    expect(c.x).toBeGreaterThanOrEqual(0n);
    expect(c.x).toBeLessThan(CURVE_P);
    expect(c.y).toBeGreaterThanOrEqual(0n);
    expect(c.y).toBeLessThan(CURVE_P);
  });

  it("is deterministic — same inputs produce same output", async () => {
    const a = await computeCommitment(100n, 999n);
    const b = await computeCommitment(100n, 999n);
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
  });

  it("different values produce different commitments (hiding)", async () => {
    const a = await computeCommitment(100n, 999n);
    const b = await computeCommitment(200n, 999n);
    expect(a.x).not.toBe(b.x);
  });

  it("different blindings produce different commitments (binding)", async () => {
    const a = await computeCommitment(100n, 111n);
    const b = await computeCommitment(100n, 222n);
    expect(a.x).not.toBe(b.x);
  });

  it("value = 0 with nonzero blinding is not identity", async () => {
    const c = await computeCommitment(0n, 1n);
    expect(isIdentityCommitment(c)).toBe(false);
  });

  it("throws if value >= 2^128 (v0.7 128-bit cap)", async () => {
    await expect(computeCommitment(1n << 128n, 1n)).rejects.toThrow(
      "value must be in [0, 2^128)"
    );
  });

  it("throws if blinding >= SUBORDER (~2^252)", async () => {
    await expect(computeCommitment(1n, SUBORDER)).rejects.toThrow(
      "blinding must be in [0, SUBORDER)"
    );
  });

  it("max valid value (2^128 - 1) is accepted", async () => {
    const c = await computeCommitment((1n << 128n) - 1n, 1n);
    expect(typeof c.x).toBe("bigint");
  });

  it("max valid blinding (SUBORDER - 1) is accepted", async () => {
    const c = await computeCommitment(1n, SUBORDER - 1n);
    expect(typeof c.x).toBe("bigint");
  });

  it("additively homomorphic: commit(a,r1)+commit(b,r2) = commit(a+b, r1+r2)", async () => {
    const a = 1000n;
    const b = 500n;
    const r1 = 12345678901234n;
    const r2 = 98765432109876n;
    const Ca = await computeCommitment(a, r1);
    const Cb = await computeCommitment(b, r2);
    const sum = await addCommitmentsLocal(Ca, Cb);
    const direct = await computeCommitment(a + b, (r1 + r2) % SUBORDER);
    expect(sum.x).toBe(direct.x);
    expect(sum.y).toBe(direct.y);
  });
});

describe("addCommitmentsLocal", () => {
  it("adding identity (0,1) to a point returns the same point", async () => {
    const c = await computeCommitment(100n, 999n);
    const identity = identityCommitment();
    const result = await addCommitmentsLocal(c, identity);
    expect(result.x).toBe(c.x);
    expect(result.y).toBe(c.y);
  });

  it("is commutative: add(a, b) == add(b, a)", async () => {
    const a = await computeCommitment(100n, 111n);
    const b = await computeCommitment(200n, 222n);
    const ab = await addCommitmentsLocal(a, b);
    const ba = await addCommitmentsLocal(b, a);
    expect(ab.x).toBe(ba.x);
    expect(ab.y).toBe(ba.y);
  });

  it("produces a valid BabyJubJub point when adding two commitments", async () => {
    const a = await computeCommitment(100n, 111n);
    const b = await computeCommitment(200n, 222n);
    const sum = await addCommitmentsLocal(a, b);
    const P = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
    expect(sum.x).toBeGreaterThanOrEqual(0n);
    expect(sum.x).toBeLessThan(P);
    expect(sum.y).toBeGreaterThanOrEqual(0n);
    expect(sum.y).toBeLessThan(P);
    expect(sum.x).not.toBe(a.x);
    expect(sum.x).not.toBe(b.x);
  });
});

describe("negateCommitment", () => {
  it("negate(identity) = identity", () => {
    const neg = negateCommitment({ x: 0n, y: 1n });
    expect(neg.x).toBe(0n);
    expect(neg.y).toBe(1n);
  });

  it("double negation returns the original point", async () => {
    const c = await computeCommitment(50n, 12345n);
    const neg = negateCommitment(c);
    const negNeg = negateCommitment(neg);
    expect(negNeg.x).toBe(c.x);
    expect(negNeg.y).toBe(c.y);
  });

  it("negate(G).x + G.x = P", async () => {
    const c = await computeCommitment(100n, 777n);
    const neg = negateCommitment(c);
    if (c.x !== 0n) {
      expect((neg.x + c.x) % CURVE_P).toBe(0n);
    }
  });
});

describe("identityCommitment / isIdentityCommitment", () => {
  it("identityCommitment() returns (0, 1)", () => {
    const id = identityCommitment();
    expect(id.x).toBe(0n);
    expect(id.y).toBe(1n);
  });

  it("isIdentityCommitment recognizes identity", () => {
    expect(isIdentityCommitment({ x: 0n, y: 1n })).toBe(true);
  });

  it("isIdentityCommitment rejects non-identity", async () => {
    const c = await computeCommitment(1n, 1n);
    expect(isIdentityCommitment(c)).toBe(false);
  });

  it("isIdentityCommitment rejects (0, 0)", () => {
    expect(isIdentityCommitment({ x: 0n, y: 0n })).toBe(false);
  });
});
