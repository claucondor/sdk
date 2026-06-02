/**
 * Unit tests for fee math helpers.
 * Tests: computeNet edge cases (0 bps, max gross, various decimals).
 */

import { describe, it, expect } from "vitest";
import {
  computeNetWrap,
  computeWrapFee,
  computeNetUnwrap,
  computeUnwrapFee,
} from "../../src/tokens/janus-flow";

describe("computeNetWrap", () => {
  it("0 bps: net == gross (no fee)", () => {
    const gross = 5_000_000_000_000_000_000n; // 5 FLOW
    expect(computeNetWrap(gross, 0)).toBe(gross);
  });

  it("10 bps (0.1%): correct net and fee", () => {
    const gross = 5_000_000_000_000_000_000n; // 5 FLOW
    const net = computeNetWrap(gross, 10);
    const fee = computeWrapFee(gross, 10);
    expect(net + fee).toBe(gross);
    // fee = 5e18 * 10 / 10000 = 5e15
    expect(fee).toBe(5_000_000_000_000_000n);
    expect(net).toBe(4_995_000_000_000_000_000n);
  });

  it("100 bps (1%): net == gross * 0.99", () => {
    const gross = 1_000_000_000_000_000_000n; // 1 FLOW
    const net = computeNetWrap(gross, 100);
    expect(net).toBe(990_000_000_000_000_000n);
  });

  it("max gross: no overflow", () => {
    const gross = (1n << 128n) - 1n; // max uint128
    const net = computeNetWrap(gross, 10);
    expect(net).toBeLessThan(gross);
    expect(net).toBeGreaterThan(0n);
  });

  it("6-decimal token (MockUSDC): 100 USDC gross, 10 bps fee", () => {
    const gross = 100_000_000n; // 100 USDC (6 decimals)
    const net = computeNetWrap(gross, 10);
    const fee = computeWrapFee(gross, 10);
    expect(fee).toBe(100_000n); // 0.1 USDC
    expect(net).toBe(99_900_000n); // 99.9 USDC
    expect(net + fee).toBe(gross);
  });

  it("8-decimal token (MockFT): 50 MockFT gross, 10 bps fee", () => {
    const gross = 5_000_000_000n; // 50 MockFT (8 decimals = 50 * 1e8)
    const net = computeNetWrap(gross, 10);
    const fee = computeWrapFee(gross, 10);
    expect(fee).toBe(5_000_000n); // 0.05 MockFT
    expect(net).toBe(4_995_000_000n);
    expect(net + fee).toBe(gross);
  });
});

describe("computeNetUnwrap", () => {
  it("0 bps: net == claimed", () => {
    const claimed = 4_000_000_000_000_000_000n;
    expect(computeNetUnwrap(claimed, 0)).toBe(claimed);
  });

  it("10 bps: correct net to recipient", () => {
    const claimed = 4_000_000_000_000_000_000n; // 4 FLOW
    const net = computeNetUnwrap(claimed, 10);
    const fee = computeUnwrapFee(claimed, 10);
    expect(net + fee).toBe(claimed);
    expect(fee).toBe(4_000_000_000_000_000n); // 0.004 FLOW
    expect(net).toBe(3_996_000_000_000_000_000n); // 3.996 FLOW
  });
});

describe("fee math symmetry: net(gross) + fee(gross) == gross", () => {
  const cases = [
    [1n, 10],
    [1_000_000n, 10],
    [1_000_000_000_000_000_000n, 10],
    [1_000_000_000_000_000_000n, 100],
    [(1n << 64n) - 1n, 10],
  ] as [bigint, number][];

  for (const [gross, bps] of cases) {
    it(`gross=${gross.toString().slice(0, 12)}..., bps=${bps}`, () => {
      const net = computeNetWrap(gross, bps);
      const fee = computeWrapFee(gross, bps);
      expect(net + fee).toBe(gross);
    });
  }
});
