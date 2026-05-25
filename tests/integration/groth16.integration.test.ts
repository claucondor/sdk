/**
 * Integration tests — ConfidentialTransferVerifier on Flow EVM testnet.
 *
 * Tests proof generation + on-chain verification against deployed contract:
 *   ConfidentialTransferVerifier: 0x0085F286d89af79EC59E27CD0c5CcD1c55f42Cf5
 *   Circuit artifacts: /home/oydual3/cadence-crypto-lab/modules/zk/confidential-transfer-circuit/
 *
 * Requires:
 *   - Internet access (Flow EVM testnet)
 *   - Circuit WASM + zkey in cadence-crypto-lab (read-only reference)
 *
 * Run: RUN_INTEGRATION=1 npx vitest run tests/integration/groth16.integration.test.ts
 * (this test takes ~30-60s for proof generation)
 */

import { describe, it, expect } from "vitest";
import { prove, proveForEVM, verifyOnChain, verifyLocally } from "../../src/primitives/groth16";
import { computeCommitment } from "../../src/primitives/pedersen";
import { readFileSync, existsSync } from "fs";

const SKIP = !process.env["RUN_INTEGRATION"];

// Circuit artifacts (read-only reference from cadence-crypto-lab)
const CIRCUIT_DIR =
  "/home/oydual3/cadence-crypto-lab/modules/zk/confidential-transfer-circuit";
const WASM_PATH = `${CIRCUIT_DIR}/circuit/build/confidential_transfer_js/confidential_transfer.wasm`;
const ZKEY_PATH = `${CIRCUIT_DIR}/setup/confidential_transfer_final.zkey`;
const VK_PATH = `${CIRCUIT_DIR}/setup/verification_key.json`;

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
  it("circuit path configuration is accessible", () => {
    expect(CIRCUIT_DIR).toContain("confidential-transfer-circuit");
  });

  if (!circuitExists) {
    it.skip("circuit files not found — skip integration proof tests", () => {});
  }
});
