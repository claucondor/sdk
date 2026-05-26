/**
 * Unit tests for elgamal-proofs — buildEncryptProof + buildDecryptProof
 *
 * Tests cover:
 *   - Module exports exist and are callable
 *   - Circuit artifact presence and validity
 *   - Proof result shape via real snarkjs proof generation (fast, small inputs)
 *   - pi_b Fp2 swap correctness
 *   - Fraud rejection: wrong amount fails witness generation
 *   - Deployment record sanity
 *
 * Timing: buildEncryptProof takes ~10–30s with real wasm+zkey.
 * Set SKIP_PROOF_TESTS=1 to skip proof generation tests (e.g. in fast CI loops).
 * Full suite must pass (RUN_SLOW_UNIT=1 or no skip flag) before release.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { applyPiBSwap, evmProofToUint256Array } from "../../src/utils/pi-b-swap.js";
import type { SnarkJSProof } from "../../src/types/proof.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..", "..");

// Circuit artifacts
const ENCRYPT_WASM = resolve(PACKAGE_ROOT, "circuits/build/encrypt_consistency.wasm");
const ENCRYPT_ZKEY = resolve(PACKAGE_ROOT, "circuits/setup/encrypt_consistency_final.zkey");
const DECRYPT_WASM = resolve(PACKAGE_ROOT, "circuits/build/decrypt_open.wasm");
const DECRYPT_ZKEY = resolve(PACKAGE_ROOT, "circuits/setup/decrypt_open_final.zkey");
const ENCRYPT_VKEY_PATH = resolve(PACKAGE_ROOT, "circuits/setup/encrypt_consistency_vkey.json");
const DECRYPT_VKEY_PATH = resolve(PACKAGE_ROOT, "circuits/setup/decrypt_open_vkey.json");

const SKIP_PROOFS = process.env["SKIP_PROOF_TESTS"] === "1";

// ---------------------------------------------------------------------------
// Circuit artifact presence (fast, no snarkjs)
// ---------------------------------------------------------------------------

describe("circuit artifact presence", () => {
  it("encrypt_consistency.wasm exists with WASM magic bytes", () => {
    const buf = readFileSync(ENCRYPT_WASM);
    expect(buf.length).toBeGreaterThan(100);
    expect(buf[0]).toBe(0x00);
    expect(buf[1]).toBe(0x61); // 'a'
    expect(buf[2]).toBe(0x73); // 's'
    expect(buf[3]).toBe(0x6d); // 'm'
  });

  it("decrypt_open.wasm exists with WASM magic bytes", () => {
    const buf = readFileSync(DECRYPT_WASM);
    expect(buf.length).toBeGreaterThan(100);
    expect(buf[0]).toBe(0x00);
    expect(buf[1]).toBe(0x61);
  });

  it("encrypt_consistency_final.zkey exists (>100KB)", () => {
    const buf = readFileSync(ENCRYPT_ZKEY);
    expect(buf.length).toBeGreaterThan(100_000);
  });

  it("decrypt_open_final.zkey exists (>100KB)", () => {
    const buf = readFileSync(DECRYPT_ZKEY);
    expect(buf.length).toBeGreaterThan(100_000);
  });

  it("encrypt_consistency_vkey.json — nPublic=6, IC has 7 elements", () => {
    const vkey = JSON.parse(readFileSync(ENCRYPT_VKEY_PATH, "utf8"));
    expect(vkey.nPublic).toBe(6);
    expect(Array.isArray(vkey.IC)).toBe(true);
    expect(vkey.IC.length).toBe(7); // nPublic + 1
  });

  it("decrypt_open_vkey.json — nPublic=7, IC has 8 elements", () => {
    const vkey = JSON.parse(readFileSync(DECRYPT_VKEY_PATH, "utf8"));
    expect(vkey.nPublic).toBe(7);
    expect(Array.isArray(vkey.IC)).toBe(true);
    expect(vkey.IC.length).toBe(8); // nPublic + 1
  });
});

// ---------------------------------------------------------------------------
// Module exports (fast import checks)
// ---------------------------------------------------------------------------

describe("elgamal-proofs module exports", () => {
  it("buildEncryptProof is a function", async () => {
    const { buildEncryptProof } = await import("../../src/crypto/elgamal-proofs.js");
    expect(typeof buildEncryptProof).toBe("function");
  });

  it("buildDecryptProof is a function", async () => {
    const { buildDecryptProof } = await import("../../src/crypto/elgamal-proofs.js");
    expect(typeof buildDecryptProof).toBe("function");
  });

  it("re-exported from src/crypto/index.ts", async () => {
    const crypto = await import("../../src/crypto/index.js");
    expect(typeof crypto.buildEncryptProof).toBe("function");
    expect(typeof crypto.buildDecryptProof).toBe("function");
  });

  it("re-exported from src/index.ts (top-level SDK)", async () => {
    const sdk = await import("../../src/index.js");
    expect(typeof sdk.buildEncryptProof).toBe("function");
    expect(typeof sdk.buildDecryptProof).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// EIP-197 pi_b swap and proof flattening — pure function tests (no snarkjs)
// These verify the transformation logic independently of proof generation.
// ---------------------------------------------------------------------------

describe("pi_b Fp2 swap (EIP-197) — pure function", () => {
  const SAMPLE: SnarkJSProof = {
    pi_a: ["100", "200", "1"],
    pi_b: [["300", "400"], ["500", "600"], ["1", "0"]],
    pi_c: ["700", "800", "1"],
    protocol: "groth16",
    curve: "bn128",
  };

  it("pA preserves pi_a[0] and pi_a[1]", () => {
    const evm = applyPiBSwap(SAMPLE);
    expect(evm.pA[0]).toBe(100n);
    expect(evm.pA[1]).toBe(200n);
  });

  it("pC preserves pi_c[0] and pi_c[1]", () => {
    const evm = applyPiBSwap(SAMPLE);
    expect(evm.pC[0]).toBe(700n);
    expect(evm.pC[1]).toBe(800n);
  });

  it("pB[0] is [pi_b[0][1], pi_b[0][0]] — im, re swapped", () => {
    const evm = applyPiBSwap(SAMPLE);
    expect(evm.pB[0][0]).toBe(400n); // pi_b[0][1] = im
    expect(evm.pB[0][1]).toBe(300n); // pi_b[0][0] = re
  });

  it("pB[1] is [pi_b[1][1], pi_b[1][0]] — im, re swapped", () => {
    const evm = applyPiBSwap(SAMPLE);
    expect(evm.pB[1][0]).toBe(600n); // pi_b[1][1] = im
    expect(evm.pB[1][1]).toBe(500n); // pi_b[1][0] = re
  });

  it("evmProofToUint256Array flattens to [pA.x, pA.y, pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC.x, pC.y]", () => {
    const evm = applyPiBSwap(SAMPLE);
    const arr = evmProofToUint256Array(evm);
    expect(arr.length).toBe(8);
    expect(arr[0]).toBe(100n);   // pA.x
    expect(arr[1]).toBe(200n);   // pA.y
    expect(arr[2]).toBe(400n);   // pB[0][0] (swapped im)
    expect(arr[3]).toBe(300n);   // pB[0][1] (swapped re)
    expect(arr[4]).toBe(600n);   // pB[1][0] (swapped im)
    expect(arr[5]).toBe(500n);   // pB[1][1] (swapped re)
    expect(arr[6]).toBe(700n);   // pC.x
    expect(arr[7]).toBe(800n);   // pC.y
  });

  it("all elements of evmProofToUint256Array are bigint", () => {
    const evm = applyPiBSwap(SAMPLE);
    const arr = evmProofToUint256Array(evm);
    for (const el of arr) {
      expect(typeof el).toBe("bigint");
    }
  });
});

// ---------------------------------------------------------------------------
// Real proof tests — use actual snarkjs + wasm + zkey
// Gated by SKIP_PROOF_TESTS environment variable.
// ---------------------------------------------------------------------------

// Derive test pubkey from sk=1234567890 using circomlibjs
async function deriveTestPubkey(sk: bigint): Promise<{ x: bigint; y: bigint }> {
  const { buildBabyjub } = await import("circomlibjs");
  const babyjub = await buildBabyjub();
  const F = babyjub.F;
  const pk = babyjub.mulPointEscalar(babyjub.Base8, sk);
  return {
    x: F.toObject(pk[0]) as bigint,
    y: F.toObject(pk[1]) as bigint,
  };
}

const TEST_SK = 1234567890n;

describe.skipIf(SKIP_PROOFS)(
  "buildEncryptProof — real proof generation",
  () => {
    it(
      "produces well-formed EncryptProofResult",
      async () => {
        const { buildEncryptProof } = await import("../../src/crypto/elgamal-proofs.js");
        const pk = await deriveTestPubkey(TEST_SK);

        const result = await buildEncryptProof(
          {
            value: 42n,
            randomness: 12345678901234567890n,
            recipientPubkey: pk,
          },
          { wasmPath: ENCRYPT_WASM, zkeyPath: ENCRYPT_ZKEY }
        );

        // proof is uint256[8]
        expect(result.proof.length).toBe(8);
        for (const el of result.proof) {
          expect(typeof el).toBe("bigint");
        }

        // publicInputs is bigint[6]
        expect(result.publicInputs.length).toBe(6);
        for (const el of result.publicInputs) {
          expect(typeof el).toBe("bigint");
        }

        // ciphertext C1 and C2 are bigint points
        expect(typeof result.ciphertext.C1.x).toBe("bigint");
        expect(typeof result.ciphertext.C1.y).toBe("bigint");
        expect(typeof result.ciphertext.C2.x).toBe("bigint");
        expect(typeof result.ciphertext.C2.y).toBe("bigint");

        // C1 matches publicInputs[2] and [3]
        expect(result.ciphertext.C1.x).toBe(result.publicInputs[2]);
        expect(result.ciphertext.C1.y).toBe(result.publicInputs[3]);
        // C2 matches publicInputs[4] and [5]
        expect(result.ciphertext.C2.x).toBe(result.publicInputs[4]);
        expect(result.ciphertext.C2.y).toBe(result.publicInputs[5]);

        // pk in publicInputs[0] and [1]
        expect(result.publicInputs[0]).toBe(pk.x);
        expect(result.publicInputs[1]).toBe(pk.y);

        // rawProof and rawPublicSignals populated
        expect(result.rawPublicSignals.length).toBe(6);
        expect(result.rawProof).toBeDefined();

        // Off-chain verification passes
        const snarkjs = await import("snarkjs");
        const vkey = JSON.parse(readFileSync(ENCRYPT_VKEY_PATH, "utf8"));
        const valid = await snarkjs.groth16.verify(
          vkey,
          result.rawPublicSignals,
          result.rawProof
        );
        expect(valid).toBe(true);
      },
      90_000
    );
  }
);

describe.skipIf(SKIP_PROOFS)(
  "buildDecryptProof — real proof generation",
  () => {
    it(
      "encrypt-then-decrypt roundtrip: proof verifies off-chain",
      async () => {
        const { buildEncryptProof, buildDecryptProof } = await import(
          "../../src/crypto/elgamal-proofs.js"
        );
        const snarkjs = await import("snarkjs");

        const pk = await deriveTestPubkey(TEST_SK);
        const amount = 42n;

        // Step 1: encrypt
        const encResult = await buildEncryptProof(
          {
            value: amount,
            randomness: 98765432109876543210n,
            recipientPubkey: pk,
          },
          { wasmPath: ENCRYPT_WASM, zkeyPath: ENCRYPT_ZKEY }
        );

        // Step 2: decrypt
        const decResult = await buildDecryptProof(
          {
            ciphertext: encResult.ciphertext,
            secretKey: TEST_SK,
            pubkey: pk,
            amount,
          },
          { wasmPath: DECRYPT_WASM, zkeyPath: DECRYPT_ZKEY }
        );

        // proof is uint256[8]
        expect(decResult.proof.length).toBe(8);
        for (const el of decResult.proof) {
          expect(typeof el).toBe("bigint");
        }

        // publicInputs is bigint[7]
        expect(decResult.publicInputs.length).toBe(7);
        // claimed_value in [6]
        expect(decResult.publicInputs[6]).toBe(amount);

        // amount preserved
        expect(decResult.amount).toBe(amount);

        // rawPublicSignals has 7 elements
        expect(decResult.rawPublicSignals.length).toBe(7);

        // Off-chain verify
        const vkey = JSON.parse(readFileSync(DECRYPT_VKEY_PATH, "utf8"));
        const valid = await snarkjs.groth16.verify(
          vkey,
          decResult.rawPublicSignals,
          decResult.rawProof
        );
        expect(valid).toBe(true);
      },
      120_000
    );

    it(
      "fraud: wrong amount causes witness generation failure",
      async () => {
        const { buildEncryptProof, buildDecryptProof } = await import(
          "../../src/crypto/elgamal-proofs.js"
        );

        const pk = await deriveTestPubkey(TEST_SK);
        const amount = 42n;

        const encResult = await buildEncryptProof(
          {
            value: amount,
            randomness: 11111111111n,
            recipientPubkey: pk,
          },
          { wasmPath: ENCRYPT_WASM, zkeyPath: ENCRYPT_ZKEY }
        );

        // Try to prove wrong amount (1000 instead of 42) — must throw
        await expect(
          buildDecryptProof(
            {
              ciphertext: encResult.ciphertext,
              secretKey: TEST_SK,
              pubkey: pk,
              amount: 1000n, // FRAUD — circuit constraint will reject this
            },
            { wasmPath: DECRYPT_WASM, zkeyPath: DECRYPT_ZKEY }
          )
        ).rejects.toThrow();
      },
      90_000
    );
  }
);

// ---------------------------------------------------------------------------
// Deployment record sanity
// ---------------------------------------------------------------------------

describe("deployments-v0.2.0.json", () => {
  it("contains expected v0.2.0 addresses matching SDK constants", () => {
    const rec = JSON.parse(
      readFileSync(
        resolve(PACKAGE_ROOT, "circuits/setup/deployments-v0.2.0.json"),
        "utf8"
      )
    );
    expect(rec.addresses.JANUS_TOKEN_EVM).toBe(
      "0xb12E600fFcde967210cFD81CF9f32bBB6e68a499"
    );
    expect(rec.addresses.ENCRYPT_CONSISTENCY_VERIFIER).toBe(
      "0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e"
    );
    expect(rec.addresses.DECRYPT_OPEN_VERIFIER).toBe(
      "0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc"
    );
    expect(rec.addresses.BABYJUB_LIBRARY).toBe(
      "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870"
    );
  });

  it("e2eTestResult shows 27/27 PASS — GO verdict", () => {
    const rec = JSON.parse(
      readFileSync(
        resolve(PACKAGE_ROOT, "circuits/setup/deployments-v0.2.0.json"),
        "utf8"
      )
    );
    expect(rec.e2eTestResult.passed).toBe(27);
    expect(rec.e2eTestResult.failed).toBe(0);
    expect(rec.e2eTestResult.verdict).toBe("GO");
  });

  it("ceremony record matches known beacon values", () => {
    const rec = JSON.parse(
      readFileSync(
        resolve(PACKAGE_ROOT, "circuits/setup/deployments-v0.2.0.json"),
        "utf8"
      )
    );
    expect(rec.ceremony.beacon).toBe("Flow testnet block 323555648");
    expect(rec.ceremony.encryptZkeyHash).toBe(
      "17ab9353f2966336bbf380549a47721ccce4283f20000380e18ecab763c3da16"
    );
    expect(rec.ceremony.decryptZkeyHash).toBe(
      "d87eda3b96f2eeab11f33583369519d041d25915cdbd49cedf41fd269b8e0745"
    );
  });
});
