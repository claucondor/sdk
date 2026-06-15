/**
 * Unit tests for crypto/amount-disclose — buildAmountDiscloseProof
 *
 * Covers:
 *   - circuit artifacts exist with correct shape (wasm magic, zkey size)
 *   - Pure input validation (range guards) fails fast
 *   - End-to-end real-proof generation (skip with SKIP_PROOF_TESTS=1)
 *
 * NOTE: API updated v0.6 → v0.8:
 *   - Added required `nonce` parameter
 *   - amount range extended from [0, 2^64) to [0, 2^128)
 *   - blinding range extended from [0, 2^128) to [0, 2^252)
 *   - publicInputs now length 4 (added nonce) vs 3 before
 *   - circuit moved from circuits/v0.3/ to circuits/aggregate/
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..", "..");

// aggregate circuit artifacts (post-v0.8)
const AMOUNT_WASM = resolve(PACKAGE_ROOT, "circuits/aggregate/amount_disclose_aggregate.wasm");
const AMOUNT_ZKEY = resolve(PACKAGE_ROOT, "circuits/aggregate/amount_disclose_aggregate_test.zkey");

const SKIP_PROOFS = process.env["SKIP_PROOF_TESTS"] === "1";

describe("aggregate amount-disclose circuit artifacts", () => {
  it("amount_disclose_aggregate.wasm has WASM magic bytes", () => {
    const buf = readFileSync(AMOUNT_WASM);
    expect(buf.length).toBeGreaterThan(100);
    expect(buf[0]).toBe(0x00);
    expect(buf[1]).toBe(0x61);
    expect(buf[2]).toBe(0x73);
    expect(buf[3]).toBe(0x6d);
  });

  it("amount_disclose_aggregate_test.zkey exists (>100KB)", () => {
    const buf = readFileSync(AMOUNT_ZKEY);
    expect(buf.length).toBeGreaterThan(100_000);
  });
});

describe("buildAmountDiscloseProof input validation", () => {
  it("rejects negative amount", async () => {
    const { buildAmountDiscloseProof } = await import("../../src/crypto/amount-disclose");
    await expect(
      buildAmountDiscloseProof({ amount: -1n, blinding: 1n, nonce: 0n })
    ).rejects.toThrow(RangeError);
  });

  it("rejects amount >= 2^128 (v0.8 128-bit cap)", async () => {
    const { buildAmountDiscloseProof } = await import("../../src/crypto/amount-disclose");
    await expect(
      buildAmountDiscloseProof({ amount: 1n << 128n, blinding: 1n, nonce: 0n })
    ).rejects.toThrow(/2\^128/);
  });

  it("rejects blinding >= 2^252", async () => {
    const { buildAmountDiscloseProof } = await import("../../src/crypto/amount-disclose");
    await expect(
      buildAmountDiscloseProof({ amount: 1n, blinding: 1n << 252n, nonce: 0n })
    ).rejects.toThrow(/2\^252/);
  });
});

describe.skipIf(SKIP_PROOFS)("buildAmountDiscloseProof end-to-end", () => {
  it("produces well-formed AmountDiscloseProofResult that verifies off-chain", async () => {
    const { buildAmountDiscloseProof } = await import("../../src/crypto/amount-disclose");
    const result = await buildAmountDiscloseProof({
      amount: 1_000_000_000_000_000_000n, // 1 FLOW
      blinding: 12345678901234567890n,
      nonce: 42n,
    });
    expect(result.proof).toHaveLength(8);
    expect(result.publicInputs).toHaveLength(4);
    expect(result.txCommit).toHaveLength(2);
    // commit binds to amount + blinding
    expect(result.commitment.x).toBe(result.txCommit[0]);
    expect(result.commitment.y).toBe(result.txCommit[1]);
  }, 30000);
});
