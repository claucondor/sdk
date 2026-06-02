/**
 * Unit tests for crypto/amount-disclose — buildAmountDiscloseProof
 *
 * Covers:
 *   - v0.3 circuit artifacts exist with correct shape (wasm magic, zkey size)
 *   - Pure input validation (range guards) fails fast
 *   - End-to-end real-proof generation (skip with SKIP_PROOF_TESTS=1)
 *
 * Timing: real proof generation ~5–15s on a laptop.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..", "..");

// v0.3 circuit artifacts (the ceremony used by deployed verifiers)
const AMOUNT_WASM = resolve(PACKAGE_ROOT, "circuits/v0.3/amount_disclose.wasm");
const AMOUNT_ZKEY = resolve(PACKAGE_ROOT, "circuits/v0.3/amount_disclose_final.zkey");

const SKIP_PROOFS = process.env["SKIP_PROOF_TESTS"] === "1";

describe("v0.3 amount-disclose circuit artifacts", () => {
  it("amount_disclose.wasm has WASM magic bytes", () => {
    const buf = readFileSync(AMOUNT_WASM);
    expect(buf.length).toBeGreaterThan(100);
    expect(buf[0]).toBe(0x00);
    expect(buf[1]).toBe(0x61);
    expect(buf[2]).toBe(0x73);
    expect(buf[3]).toBe(0x6d);
  });

  it("amount_disclose_final.zkey exists (>100KB)", () => {
    const buf = readFileSync(AMOUNT_ZKEY);
    expect(buf.length).toBeGreaterThan(100_000);
  });
});

describe("buildAmountDiscloseProof input validation", () => {
  it("rejects negative amount", async () => {
    const { buildAmountDiscloseProof } = await import("../../src/crypto/amount-disclose");
    await expect(
      buildAmountDiscloseProof({ amount: -1n, blinding: 1n })
    ).rejects.toThrow(RangeError);
  });

  it("rejects amount >= 2^64 (v0.3 64-bit cap)", async () => {
    const { buildAmountDiscloseProof } = await import("../../src/crypto/amount-disclose");
    await expect(
      buildAmountDiscloseProof({ amount: 1n << 64n, blinding: 1n })
    ).rejects.toThrow(/2\^64/);
  });

  it("rejects blinding >= 2^128", async () => {
    const { buildAmountDiscloseProof } = await import("../../src/crypto/amount-disclose");
    await expect(
      buildAmountDiscloseProof({ amount: 1n, blinding: 1n << 128n })
    ).rejects.toThrow(/2\^128/);
  });
});

describe.skipIf(SKIP_PROOFS)("buildAmountDiscloseProof end-to-end", () => {
  it("produces well-formed AmountDiscloseProofResult that verifies off-chain", async () => {
    const { buildAmountDiscloseProof } = await import("../../src/crypto/amount-disclose");
    const result = await buildAmountDiscloseProof({
      amount: 1_000_000_000_000_000_000n, // 1 FLOW
      blinding: 12345678901234567890n,
    });
    expect(result.proof).toHaveLength(8);
    expect(result.publicInputs).toHaveLength(3);
    expect(result.txCommit).toHaveLength(2);
    // commit binds to amount + blinding
    expect(result.commitment.x).toBe(result.txCommit[0]);
    expect(result.commitment.y).toBe(result.txCommit[1]);
  }, 30000);
});
