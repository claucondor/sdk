/**
 * Integration tests — v0.3 ConfidentialTransferVerifier on Flow EVM testnet.
 *
 * Tests proof generation + on-chain verification against the deployed v0.3
 * contract:
 *   ConfidentialTransferVerifier: 0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B
 *   Circuit artifacts: bundled in circuits/v0.3/
 *
 * Requires:
 *   - Internet access (Flow EVM testnet)
 *
 * Run: RUN_INTEGRATION=1 npx vitest run tests/integration/groth16.integration.test.ts
 * (this test takes ~30-60s for proof generation)
 */

import { describe, it, expect } from "vitest";
import { prove, proveForEVM, verifyOnChain, verifyLocally } from "../../src/primitives/groth16";
import { computeCommitment } from "../../src/primitives/pedersen";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..", "..");

const SKIP = !process.env["RUN_INTEGRATION"];

// Bundled v0.3 circuit artifacts
const WASM_PATH = resolve(PACKAGE_ROOT, "circuits/v0.3/confidential_transfer.wasm");
const ZKEY_PATH = resolve(PACKAGE_ROOT, "circuits/v0.3/confidential_transfer_final.zkey");
const VK_PATH = resolve(PACKAGE_ROOT, "circuits/v0.3/confidential_transfer_vkey.json");

const circuitExists =
  existsSync(WASM_PATH) && existsSync(ZKEY_PATH) && existsSync(VK_PATH);

describe.skipIf(SKIP || !circuitExists)(
  "ConfidentialTransferVerifier integration",
  () => {
    // Test parameters
    const OLD_BALANCE = 10n;
    const OLD_BLINDING = 111n;
    const TRANSFER_AMOUNT = 3n;
    const TRANSFER_BLINDING = 222n;
    const NEW_BLINDING = 333n;

    it(
      "I1: prove() + verifyLocally() passes for valid transfer (10 - 3 = 7)",
      async () => {
        const newBalance = OLD_BALANCE - TRANSFER_AMOUNT;

        const oldCommit = await computeCommitment(OLD_BALANCE, OLD_BLINDING);
        const transferCommit = await computeCommitment(TRANSFER_AMOUNT, TRANSFER_BLINDING);
        const newCommit = await computeCommitment(newBalance, NEW_BLINDING);

        const circuitInput = {
          old_value: OLD_BALANCE.toString(),
          old_blinding: OLD_BLINDING.toString(),
          transfer_value: TRANSFER_AMOUNT.toString(),
          transfer_blinding: TRANSFER_BLINDING.toString(),
          new_blinding: NEW_BLINDING.toString(),
          old_commit: [oldCommit.x.toString(), oldCommit.y.toString()],
          transfer_commit: [transferCommit.x.toString(), transferCommit.y.toString()],
          new_commit: [newCommit.x.toString(), newCommit.y.toString()],
        };

        const { proof, publicSignals } = await prove(circuitInput, {
          wasmPath: WASM_PATH,
          zkeyPath: ZKEY_PATH,
        });

        const vk = JSON.parse(readFileSync(VK_PATH, "utf8")) as object;
        const localOk = await verifyLocally(vk, proof, publicSignals);
        expect(localOk).toBe(true);

        // Public signals should match our commitments
        expect(BigInt(publicSignals[0])).toBe(oldCommit.x);
        expect(BigInt(publicSignals[1])).toBe(oldCommit.y);
        expect(BigInt(publicSignals[2])).toBe(transferCommit.x);
        expect(BigInt(publicSignals[3])).toBe(transferCommit.y);
        expect(BigInt(publicSignals[4])).toBe(newCommit.x);
        expect(BigInt(publicSignals[5])).toBe(newCommit.y);
      },
      120000
    );

    it(
      "I2: proveForEVM() + verifyOnChain() returns true on Flow EVM testnet",
      async () => {
        const newBalance = OLD_BALANCE - TRANSFER_AMOUNT;

        const oldCommit = await computeCommitment(OLD_BALANCE, OLD_BLINDING);
        const transferCommit = await computeCommitment(TRANSFER_AMOUNT, TRANSFER_BLINDING);
        const newCommit = await computeCommitment(newBalance, NEW_BLINDING);

        const circuitInput = {
          old_value: OLD_BALANCE.toString(),
          old_blinding: OLD_BLINDING.toString(),
          transfer_value: TRANSFER_AMOUNT.toString(),
          transfer_blinding: TRANSFER_BLINDING.toString(),
          new_blinding: NEW_BLINDING.toString(),
          old_commit: [oldCommit.x.toString(), oldCommit.y.toString()],
          transfer_commit: [transferCommit.x.toString(), transferCommit.y.toString()],
          new_commit: [newCommit.x.toString(), newCommit.y.toString()],
        };

        const { rawProof, publicSignals } = await proveForEVM(circuitInput, {
          wasmPath: WASM_PATH,
          zkeyPath: ZKEY_PATH,
        });

        const onChainOk = await verifyOnChain(rawProof, publicSignals);
        expect(onChainOk).toBe(true);
      },
      120000
    );
  }
);

describe("ConfidentialTransferVerifier (skipped without RUN_INTEGRATION=1 + circuit files)", () => {
  it("bundled circuit path resolves to circuits/v0.3/", () => {
    expect(WASM_PATH).toContain("circuits/v0.3");
    expect(ZKEY_PATH).toContain("circuits/v0.3");
    expect(VK_PATH).toContain("circuits/v0.3");
  });

  if (!circuitExists) {
    it.skip("circuit files not found — skip integration proof tests", () => {});
  }
});
