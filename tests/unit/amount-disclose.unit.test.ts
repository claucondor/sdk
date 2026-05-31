/**
 * Unit tests for crypto/amount-disclose — buildAmountDiscloseProof
 *
 * Covers:
 *   - Bundled v0.5 circuit artifacts exist with correct shape (wasm magic, vkey nPublic)
 *   - Module exports re-exported via crypto/ and the top-level SDK
 *   - Pure input validation (range guards) fails fast
 *   - End-to-end real-proof generation (gated by SKIP_PROOF_TESTS=1)
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

// v0.5.1 circuit artifacts (pot18 ceremony)
const AMOUNT_WASM = resolve(PACKAGE_ROOT, "circuits/v0.5.1/amount_disclose.wasm");
const AMOUNT_ZKEY = resolve(PACKAGE_ROOT, "circuits/v0.5.1/amount_disclose_final.zkey");
const AMOUNT_VKEY = resolve(PACKAGE_ROOT, "circuits/v0.5.1/amount_disclose_vkey.json");

const SKIP_PROOFS = process.env["SKIP_PROOF_TESTS"] === "1";

// ---------------------------------------------------------------------------
// Bundled artifact presence
// ---------------------------------------------------------------------------

describe("v0.5.1 amount-disclose circuit artifacts", () => {
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

  it("amount_disclose_vkey.json has nPublic=3 (claimed_amount + commit[2])", () => {
    const vk = JSON.parse(readFileSync(AMOUNT_VKEY, "utf8"));
    expect(vk.nPublic).toBe(3);
    expect(Array.isArray(vk.IC)).toBe(true);
    expect(vk.IC.length).toBe(4); // nPublic + 1
  });
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe("amount-disclose module exports", () => {
  it("buildAmountDiscloseProof is exported from crypto/", async () => {
    const mod = await import("../../src/crypto/index.js");
    expect(typeof mod.buildAmountDiscloseProof).toBe("function");
  });

  it("buildAmountDiscloseProof is exported from the top-level SDK", async () => {
    const sdk = await import("../../src/index.js");
    expect(typeof sdk.buildAmountDiscloseProof).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Input validation (v0.5: amount range is [0, 2^128))
// ---------------------------------------------------------------------------

describe("buildAmountDiscloseProof input validation", () => {
  it("accepts amount = 2^64 without a range-guard RangeError (v0.5 128-bit cap)", async () => {
    // v0.5 circuit uses Num2Bits(128); amounts up to 2^128-1 pass the SDK guard.
    // 2^64 was the old rejection threshold — confirm no RangeError is thrown.
    // (The proof will succeed; blinding=1 is a degenerate but valid witness.)
    const { buildAmountDiscloseProof } = await import(
      "../../src/crypto/amount-disclose.js"
    );
    // This should resolve without throwing /amount must be in/
    let threw = false;
    try {
      await buildAmountDiscloseProof({ amount: 1n << 64n, blinding: 1n });
    } catch (e) {
      if (e instanceof RangeError && /amount must be in/.test(e.message)) {
        threw = true;
      }
    }
    expect(threw).toBe(false);
  });

  it("rejects amount >= 2^128", async () => {
    const { buildAmountDiscloseProof } = await import(
      "../../src/crypto/amount-disclose.js"
    );
    await expect(
      buildAmountDiscloseProof({ amount: 1n << 128n, blinding: 1n })
    ).rejects.toThrow(/amount must be in/);
  });

  it("rejects negative amount", async () => {
    const { buildAmountDiscloseProof } = await import(
      "../../src/crypto/amount-disclose.js"
    );
    await expect(
      buildAmountDiscloseProof({ amount: -1n, blinding: 1n })
    ).rejects.toThrow(/amount must be in/);
  });

  it("rejects blinding >= 2^128", async () => {
    const { buildAmountDiscloseProof } = await import(
      "../../src/crypto/amount-disclose.js"
    );
    await expect(
      buildAmountDiscloseProof({ amount: 1n, blinding: 1n << 128n })
    ).rejects.toThrow(/blinding must be in/);
  });
});

// ---------------------------------------------------------------------------
// Real-proof generation
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_PROOFS)("buildAmountDiscloseProof end-to-end", () => {
  it(
    "produces well-formed AmountDiscloseProofResult that verifies off-chain",
    async () => {
      const { buildAmountDiscloseProof } = await import(
        "../../src/crypto/amount-disclose.js"
      );
      const snarkjs = await import("snarkjs");

      const amount = 1_000_000_000_000_000_000n; // 1 FLOW in attoFLOW
      const blinding = 0x1234_5678_9abc_def0_1234_5678_9abc_def0n;

      const result = await buildAmountDiscloseProof({ amount, blinding });

      // Shape
      expect(result.proof.length).toBe(8);
      expect(result.publicInputs.length).toBe(3);
      expect(result.publicInputs[0]).toBe(amount);
      expect(result.publicInputs[1]).toBe(result.commitment.x);
      expect(result.publicInputs[2]).toBe(result.commitment.y);

      // txCommit convenience tuple matches commitment
      expect(result.txCommit[0]).toBe(result.commitment.x);
      expect(result.txCommit[1]).toBe(result.commitment.y);

      // Off-chain verify against bundled v0.5 vkey
      const vk = JSON.parse(readFileSync(AMOUNT_VKEY, "utf8"));
      const ok = await snarkjs.groth16.verify(
        vk,
        result.rawPublicSignals,
        result.rawProof
      );
      expect(ok).toBe(true);
    },
    60_000
  );
});
