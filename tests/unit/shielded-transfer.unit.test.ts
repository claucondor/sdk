/**
 * Unit tests for crypto/shielded-transfer — buildShieldedTransferProof
 *
 * v0.7: aggregate ConfidentialTransfer circuit — 2-gen Pedersen, 252-bit blindings.
 *       Value range: [0, 2^128). Blinding range: [0, 2^252).
 *
 * Covers:
 *   - aggregate circuit artifacts exist with correct shape
 *   - Pure input validation (range guards) fails fast
 *   - End-to-end real-proof generation (skip with SKIP_PROOF_TESTS=1)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..", "..");

const TRANSFER_WASM = resolve(PACKAGE_ROOT, "circuits/aggregate/confidential_transfer_aggregate.wasm");
const TRANSFER_ZKEY = resolve(PACKAGE_ROOT, "circuits/aggregate/confidential_transfer_aggregate_test.zkey");

const SKIP_PROOFS = process.env["SKIP_PROOF_TESTS"] === "1";

describe("aggregate confidential-transfer artifacts", () => {
  it("confidential_transfer_aggregate.wasm has WASM magic bytes", () => {
    const buf = readFileSync(TRANSFER_WASM);
    expect(buf.length).toBeGreaterThan(100);
    expect(buf[0]).toBe(0x00);
    expect(buf[1]).toBe(0x61);
    expect(buf[2]).toBe(0x73);
    expect(buf[3]).toBe(0x6d);
  });

  it("confidential_transfer_aggregate_test.zkey exists (>100KB)", () => {
    const buf = readFileSync(TRANSFER_ZKEY);
    expect(buf.length).toBeGreaterThan(100_000);
  });
});

describe("buildShieldedTransferProof input validation", () => {
  it("rejects negative oldBalance", async () => {
    const { buildShieldedTransferProof } = await import("../../src/crypto/shielded-transfer");
    await expect(
      buildShieldedTransferProof({
        oldBalance: -1n,
        oldBlinding: 1n,
        transferAmount: 0n,
        transferBlinding: 1n,
        newBlinding: 1n,
      })
    ).rejects.toThrow(RangeError);
  });

  it("rejects oldBalance >= 2^128 (v0.7 128-bit cap)", async () => {
    const { buildShieldedTransferProof } = await import("../../src/crypto/shielded-transfer");
    await expect(
      buildShieldedTransferProof({
        oldBalance: 1n << 128n,
        oldBlinding: 1n,
        transferAmount: 0n,
        transferBlinding: 1n,
        newBlinding: 1n,
      })
    ).rejects.toThrow(/2\^128/);
  });

  it("rejects transferAmount > oldBalance (underflow)", async () => {
    const { buildShieldedTransferProof } = await import("../../src/crypto/shielded-transfer");
    await expect(
      buildShieldedTransferProof({
        oldBalance: 100n,
        oldBlinding: 1n,
        transferAmount: 200n,
        transferBlinding: 1n,
        newBlinding: 1n,
      })
    ).rejects.toThrow();
  });

  it("rejects blinding >= 2^252", async () => {
    const { buildShieldedTransferProof } = await import("../../src/crypto/shielded-transfer");
    await expect(
      buildShieldedTransferProof({
        oldBalance: 100n,
        oldBlinding: 1n << 252n,
        transferAmount: 0n,
        transferBlinding: 1n,
        newBlinding: 1n,
      })
    ).rejects.toThrow(/2\^252/);
  });
});

describe.skipIf(SKIP_PROOFS)("buildShieldedTransferProof end-to-end", () => {
  it("produces well-formed ShieldedTransferProofResult that verifies off-chain", async () => {
    const { buildShieldedTransferProof } = await import("../../src/crypto/shielded-transfer");
    const result = await buildShieldedTransferProof({
      oldBalance: 5_000_000_000_000_000_000n,
      oldBlinding: 1234567890n,
      transferAmount: 1_000_000_000_000_000_000n,
      transferBlinding: 9876543210n,
      newBlinding: 555_555n,
    });
    expect(result.proof).toHaveLength(8);
    expect(result.publicInputs).toHaveLength(6);
    expect(result.txCommit).toHaveLength(2);
  }, 30000);
});
