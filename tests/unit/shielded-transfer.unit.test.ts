/**
 * Unit tests for crypto/shielded-transfer — buildShieldedTransferProof
 *
 * Covers:
 *   - Bundled v0.5 ConfidentialTransfer circuit artifacts (wasm magic, vkey nPublic)
 *   - Module exports re-exported via crypto/ and the top-level SDK
 *   - Pure input validation (transfer > balance, range guards)
 *   - End-to-end real-proof generation (gated by SKIP_PROOF_TESTS=1)
 *
 * Timing: real proof generation ~10–25s on a laptop.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..", "..");

// v0.5.1 circuit artifacts (pot18 ceremony)
const TRANSFER_WASM = resolve(PACKAGE_ROOT, "circuits/v0.5.1/confidential_transfer.wasm");
const TRANSFER_ZKEY = resolve(PACKAGE_ROOT, "circuits/v0.5.1/confidential_transfer_final.zkey");
const TRANSFER_VKEY = resolve(PACKAGE_ROOT, "circuits/v0.5.1/confidential_transfer_vkey.json");

const SKIP_PROOFS = process.env["SKIP_PROOF_TESTS"] === "1";

describe("v0.5.1 confidential-transfer artifacts", () => {
  it("confidential_transfer.wasm has WASM magic bytes", () => {
    const buf = readFileSync(TRANSFER_WASM);
    expect(buf.length).toBeGreaterThan(100);
    expect(buf[0]).toBe(0x00);
    expect(buf[1]).toBe(0x61);
  });

  it("confidential_transfer_final.zkey exists (>100KB)", () => {
    const buf = readFileSync(TRANSFER_ZKEY);
    expect(buf.length).toBeGreaterThan(100_000);
  });

  it("confidential_transfer_vkey.json has nPublic=6 (3 commitments)", () => {
    const vk = JSON.parse(readFileSync(TRANSFER_VKEY, "utf8"));
    expect(vk.nPublic).toBe(6);
    expect(Array.isArray(vk.IC)).toBe(true);
    expect(vk.IC.length).toBe(7);
  });
});

describe("shielded-transfer module exports", () => {
  it("buildShieldedTransferProof is exported from crypto/", async () => {
    const mod = await import("../../src/crypto/index.js");
    expect(typeof mod.buildShieldedTransferProof).toBe("function");
  });

  it("buildShieldedTransferProof is exported from the top-level SDK", async () => {
    const sdk = await import("../../src/index.js");
    expect(typeof sdk.buildShieldedTransferProof).toBe("function");
  });
});

describe("buildShieldedTransferProof input validation", () => {
  it("rejects transferAmount > oldBalance", async () => {
    const { buildShieldedTransferProof } = await import(
      "../../src/crypto/shielded-transfer.js"
    );
    await expect(
      buildShieldedTransferProof({
        oldBalance: 5n,
        oldBlinding: 1n,
        transferAmount: 10n,
        transferBlinding: 2n,
        newBlinding: 3n,
      })
    ).rejects.toThrow(/transferAmount must be in/);
  });

  it("accepts oldBalance = 2^64 without a range-guard RangeError (v0.5 128-bit cap)", async () => {
    // v0.5 circuit uses LessEqThan(128) + Num2Bits(128); balances up to 2^128-1 pass the guard.
    // 2^64 was the old rejection threshold — confirm no RangeError fires.
    const { buildShieldedTransferProof } = await import(
      "../../src/crypto/shielded-transfer.js"
    );
    let threw = false;
    try {
      await buildShieldedTransferProof({
        oldBalance: 1n << 64n,
        oldBlinding: 1n,
        transferAmount: 1n,
        transferBlinding: 2n,
        newBlinding: 3n,
      });
    } catch (e) {
      if (e instanceof RangeError && /oldBalance must be in/.test(e.message)) {
        threw = true;
      }
    }
    expect(threw).toBe(false);
  });

  it("rejects oldBalance >= 2^128", async () => {
    const { buildShieldedTransferProof } = await import(
      "../../src/crypto/shielded-transfer.js"
    );
    await expect(
      buildShieldedTransferProof({
        oldBalance: 1n << 128n,
        oldBlinding: 1n,
        transferAmount: 1n,
        transferBlinding: 2n,
        newBlinding: 3n,
      })
    ).rejects.toThrow(/oldBalance must be in/);
  });

  it("rejects blinding >= 2^128", async () => {
    const { buildShieldedTransferProof } = await import(
      "../../src/crypto/shielded-transfer.js"
    );
    await expect(
      buildShieldedTransferProof({
        oldBalance: 10n,
        oldBlinding: 1n << 128n,
        transferAmount: 1n,
        transferBlinding: 2n,
        newBlinding: 3n,
      })
    ).rejects.toThrow(/oldBlinding out of range/);
  });
});

describe.skipIf(SKIP_PROOFS)("buildShieldedTransferProof end-to-end", () => {
  it(
    "produces well-formed ShieldedTransferProofResult that verifies off-chain",
    async () => {
      const { buildShieldedTransferProof } = await import(
        "../../src/crypto/shielded-transfer.js"
      );
      const snarkjs = await import("snarkjs");

      const result = await buildShieldedTransferProof({
        oldBalance: 100n,
        oldBlinding: 0xdeadbeefcafebabe_1234567890abcdefn,
        transferAmount: 42n,
        transferBlinding: 0xabba_d00d_f00d_face_aabb_ccdd_eeff_0011n,
        newBlinding: 0x1234_5678_9abc_def0_aabb_ccdd_eeff_2233n,
      });

      // proof + publicInputs shape
      expect(result.proof.length).toBe(8);
      expect(result.publicInputs.length).toBe(6);

      // publicInputs[0..1] = oldCommit, [2..3] = txCommit, [4..5] = newCommit
      expect(result.publicInputs[0]).toBe(result.commitments.oldCommit.x);
      expect(result.publicInputs[1]).toBe(result.commitments.oldCommit.y);
      expect(result.publicInputs[2]).toBe(result.commitments.transferCommit.x);
      expect(result.publicInputs[3]).toBe(result.commitments.transferCommit.y);
      expect(result.publicInputs[4]).toBe(result.commitments.newCommit.x);
      expect(result.publicInputs[5]).toBe(result.commitments.newCommit.y);

      // txCommit convenience tuple
      expect(result.txCommit[0]).toBe(result.commitments.transferCommit.x);
      expect(result.txCommit[1]).toBe(result.commitments.transferCommit.y);

      // Off-chain verify
      const vk = JSON.parse(readFileSync(TRANSFER_VKEY, "utf8"));
      const ok = await snarkjs.groth16.verify(
        vk,
        result.rawPublicSignals,
        result.rawProof
      );
      expect(ok).toBe(true);
    },
    120_000
  );
});
