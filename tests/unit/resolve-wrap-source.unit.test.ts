/**
 * Unit tests for resolveWrapSource — pure decision logic.
 */

import { describe, it, expect } from "vitest";
import { resolveWrapSource } from "../../src/tokens/janus-flow";

describe("resolveWrapSource", () => {
  it("auto prefers vault when it can cover", () => {
    const result = resolveWrapSource({
      amountWei: 1_000_000_000_000_000_000n,
      vaultWei: 2_000_000_000_000_000_000n,
      coaWei: 5_000_000_000_000_000_000n,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe("vault");
  });

  it("auto falls back to COA when vault is insufficient", () => {
    const result = resolveWrapSource({
      amountWei: 3_000_000_000_000_000_000n,
      vaultWei: 1_000_000_000_000_000_000n,
      coaWei: 5_000_000_000_000_000_000n,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe("coa");
  });

  it("returns error when neither source can cover", () => {
    const result = resolveWrapSource({
      amountWei: 10_000_000_000_000_000_000n,
      vaultWei: 1_000_000_000_000_000_000n,
      coaWei: 5_000_000_000_000_000_000n,
    });
    expect(result.ok).toBe(false);
  });

  it("preference=vault enforces the source", () => {
    const result = resolveWrapSource({
      amountWei: 1_000_000_000_000_000_000n,
      vaultWei: 500_000_000_000_000_000n,
      coaWei: 5_000_000_000_000_000_000n,
      preference: "vault",
    });
    expect(result.ok).toBe(false);
  });

  it("preference=coa enforces the source", () => {
    const result = resolveWrapSource({
      amountWei: 1_000_000_000_000_000_000n,
      vaultWei: 5_000_000_000_000_000_000n,
      coaWei: 500_000_000_000_000_000n,
      preference: "coa",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects zero amount", () => {
    const result = resolveWrapSource({
      amountWei: 0n,
      vaultWei: 1n,
      coaWei: 1n,
    });
    expect(result.ok).toBe(false);
  });
});
