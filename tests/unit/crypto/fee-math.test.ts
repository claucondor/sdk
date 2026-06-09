/**
 * tests/unit/crypto/fee-math.test.ts
 *
 * Pure bigint fee-math helpers — no I/O, no crypto, no network.
 */
import { describe, it, expect } from "vitest";
import {
  computeNetWrap,
  computeWrapFee,
  computeNetUnwrap,
  computeUnwrapFee,
} from "../../../src/crypto/fee-math";

describe("fee-math", () => {
  describe("computeWrapFee", () => {
    it("returns 0 when feeBps is 0", () => {
      expect(computeWrapFee(1_000_000n, 0)).toBe(0n);
    });

    it("rounds down for 10 bps (0.1%)", () => {
      // 1_000_000 * 10 / 10000 = 1000
      expect(computeWrapFee(1_000_000n, 10)).toBe(1000n);
    });

    it("rounds down for 100 bps (1%)", () => {
      expect(computeWrapFee(1_000_000n, 100)).toBe(10_000n);
    });

    it("handles large amounts (1e18 wei)", () => {
      const gross = 1_000_000_000_000_000_000n; // 1 FLOW in attoFLOW
      const fee = computeWrapFee(gross, 10); // 0.1% = 10 bps
      // 1e18 * 10 / 10000 = 1e18 / 1000 = 1e15
      expect(fee).toBe(1_000_000_000_000_000n);
    });
  });

  describe("computeNetWrap", () => {
    it("net = gross when fee is 0", () => {
      expect(computeNetWrap(5_000_000n, 0)).toBe(5_000_000n);
    });

    it("net + fee = gross for 10 bps", () => {
      const gross = 1_000_000n;
      const net = computeNetWrap(gross, 10);
      const fee = computeWrapFee(gross, 10);
      expect(net + fee).toBe(gross);
    });

    it("rounds down (floor)", () => {
      // 9999 * 10 / 10000 = 9.999 → floor = 9; net = 9999 - 9 = 9990
      const gross = 9999n;
      const fee = computeWrapFee(gross, 10);
      expect(fee).toBe(9n);
      expect(computeNetWrap(gross, 10)).toBe(9990n);
    });
  });

  describe("computeUnwrapFee", () => {
    it("returns 0 when feeBps is 0", () => {
      expect(computeUnwrapFee(500n, 0)).toBe(0n);
    });

    it("same formula as wrap fee", () => {
      const amount = 777_777n;
      expect(computeUnwrapFee(amount, 50)).toBe(computeWrapFee(amount, 50));
    });
  });

  describe("computeNetUnwrap", () => {
    it("same formula as net wrap", () => {
      const claimed = 8_888_888n;
      expect(computeNetUnwrap(claimed, 25)).toBe(computeNetWrap(claimed, 25));
    });

    it("invariant: net + fee = claimed", () => {
      const claimed = 1_234_567n;
      const bps = 15;
      const net = computeNetUnwrap(claimed, bps);
      const fee = computeUnwrapFee(claimed, bps);
      expect(net + fee).toBe(claimed);
    });
  });
});
