/**
 * memokey-vectors.test.ts — Locked derivation regression test.
 *
 * These vectors pin EVERY byte of the memokey derivation algorithm to its
 * current output. If ANY of the following change, this test will break:
 *
 *   - MEMO_KEY_CONTEXT ("openjanus/memokey/v1")
 *   - HKDF salt ("openjanus/derive-babyjub/v1")
 *   - HKDF info = UTF-8(MEMO_KEY_CONTEXT)
 *   - HKDF output length (64 bytes)
 *   - Hash algorithm (SHA-256)
 *   - BabyJub subgroup order (2736030358979909402780800718157159386076813972158567259200215660948447373041)
 *   - Field reduction: bigEndianToBigInt(hkdfOutput) % BABYJUB_SUBGROUP_ORDER
 *
 * DO NOT regenerate expected values to make a failing test pass.
 * A failing test means backward compatibility is BROKEN — existing user
 * snapshots cannot be decrypted with the new derivation. That is a fund-loss
 * event. Investigate and revert the derivation change instead.
 *
 * To add a legitimate new derivation (post-quantum upgrade, etc.):
 *   1. Export old derivation as deriveMemoKeyV1()
 *   2. Add new deriveMemoKeyV2()
 *   3. Provide re-encryption tooling for existing snapshots
 *   4. Coordinate with all users via announcement + UI prompt
 *   5. THEN update these vectors to cover both V1 and V2
 */

import { createHash } from "crypto";
import { describe, it, expect } from "vitest";
import { deriveBabyJubKeypairFromBytes } from "../../src/crypto/derive-keypair";
import { MEMO_KEY_CONTEXT } from "../../src/crypto/memokey";

// ---------------------------------------------------------------------------
// Locked test vectors — generated 2026-06-03 against SDK v0.6.7
//
// Generation method (one-time, DO NOT re-run to "fix" failures):
//   node --input-type=module <<EOF
//   import { createHash } from "crypto";
//   import { deriveBabyJubKeypairFromBytes } from "./dist/crypto/index.js";
//   // sha256("test-vector-001") → deriveBabyJubKeypairFromBytes(bytes, "openjanus/memokey/v1")
//   // ...capture privkey, pubkey.x, pubkey.y as bigints
//   EOF
// ---------------------------------------------------------------------------

/**
 * Vector 1: SHA-256("test-vector-001") as IKM, context = MEMO_KEY_CONTEXT
 *
 * IKM (hex): 813389e78b4b4ff85e968f9aad55da950024eec69119aac4bd37ad61d4c0add4
 */
const VECTOR_1 = {
  label: "sha256(test-vector-001) with MEMO_KEY_CONTEXT",
  inputHex:
    "813389e78b4b4ff85e968f9aad55da950024eec69119aac4bd37ad61d4c0add4",
  context: "openjanus/memokey/v1",
  expectedPrivkey:
    914973044445000594630925588248931704203905198306616646586357967086820063813n,
  expectedPubkeyX:
    1955706794298648582942496704686820277656105011260079868136051715250894098496n,
  expectedPubkeyY:
    2307604003531865190854059413892612481565554351963815704570651938428027687278n,
} as const;

/**
 * Vector 2: SHA-256("test-vector-002") as IKM, context = MEMO_KEY_CONTEXT
 *
 * IKM (hex): cd367324c8ca120044516941248495aa34af2b11d0bedc0160d4690072722f20
 */
const VECTOR_2 = {
  label: "sha256(test-vector-002) with MEMO_KEY_CONTEXT",
  inputHex:
    "cd367324c8ca120044516941248495aa34af2b11d0bedc0160d4690072722f20",
  context: "openjanus/memokey/v1",
  expectedPrivkey:
    2453632292393878323880721190951213749776148170710745768027472148259508918075n,
  expectedPubkeyX:
    12150818493416889063844288568263452380842154146624721412700578052085993362531n,
  expectedPubkeyY:
    5719879707260408671588327802630625898947543973826883170003655156514091804313n,
} as const;

/**
 * Vector 3: 65-byte deterministic pattern (simulates a Flow wallet ECDSA signature).
 *
 * Pattern: byte[i] = (0x0a + i * 0x07) & 0xff for i in [0, 64]
 * IKM (hex): 0a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3
 *            eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3ca
 *
 * This vector uses the full 65-byte length of a typical EIP-191 personal_sign
 * output (r=32B, s=32B, v=1B), exercising the real-world input size.
 */
const VECTOR_3 = {
  label: "65-byte deterministic pattern (Flow wallet sig shape) with MEMO_KEY_CONTEXT",
  inputHex:
    "0a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3" +
    "eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3ca",
  context: "openjanus/memokey/v1",
  expectedPrivkey:
    1178314243616402812823163254317605117607410992129988569754340011377410750925n,
  expectedPubkeyX:
    12899201442229956574763566474839642935923834583604123057566936558755998746597n,
  expectedPubkeyY:
    4829135128182024606283039280636268565437171260274942032361461757795627625986n,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, "");
  const arr = new Uint8Array(clean.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memokey derivation — locked regression vectors", () => {
  it("MEMO_KEY_CONTEXT constant is exactly 'openjanus/memokey/v1'", () => {
    // This assertion locks the exported constant. If the string ever changes,
    // all three derivation vectors below will also break (double guard).
    expect(MEMO_KEY_CONTEXT).toBe("openjanus/memokey/v1");
  });

  it("Vector 1: sha256(test-vector-001) → known privkey + pubkey", async () => {
    const input = hexToBytes(VECTOR_1.inputHex);
    // Cross-check input generation is stable (SHA-256 is deterministic by spec)
    const recomputed = createHash("sha256").update("test-vector-001").digest();
    expect(Buffer.from(recomputed).toString("hex")).toBe(VECTOR_1.inputHex);

    const kp = await deriveBabyJubKeypairFromBytes(input, VECTOR_1.context);
    expect(kp.privkey).toBe(VECTOR_1.expectedPrivkey);
    expect(kp.pubkey.x).toBe(VECTOR_1.expectedPubkeyX);
    expect(kp.pubkey.y).toBe(VECTOR_1.expectedPubkeyY);
  });

  it("Vector 2: sha256(test-vector-002) → known privkey + pubkey", async () => {
    const input = hexToBytes(VECTOR_2.inputHex);
    const recomputed = createHash("sha256").update("test-vector-002").digest();
    expect(Buffer.from(recomputed).toString("hex")).toBe(VECTOR_2.inputHex);

    const kp = await deriveBabyJubKeypairFromBytes(input, VECTOR_2.context);
    expect(kp.privkey).toBe(VECTOR_2.expectedPrivkey);
    expect(kp.pubkey.x).toBe(VECTOR_2.expectedPubkeyX);
    expect(kp.pubkey.y).toBe(VECTOR_2.expectedPubkeyY);
  });

  it("Vector 3: 65-byte wallet-sig pattern → known privkey + pubkey", async () => {
    const input = hexToBytes(VECTOR_3.inputHex);
    expect(input.length).toBe(65); // Assert 65-byte length is preserved

    const kp = await deriveBabyJubKeypairFromBytes(input, VECTOR_3.context);
    expect(kp.privkey).toBe(VECTOR_3.expectedPrivkey);
    expect(kp.pubkey.x).toBe(VECTOR_3.expectedPubkeyX);
    expect(kp.pubkey.y).toBe(VECTOR_3.expectedPubkeyY);
  });

  it("all 3 vectors produce distinct privkeys (no accidental collision)", () => {
    // Sanity check that the three vectors are genuinely independent
    const privkeys = [
      VECTOR_1.expectedPrivkey,
      VECTOR_2.expectedPrivkey,
      VECTOR_3.expectedPrivkey,
    ];
    const unique = new Set(privkeys.map(String));
    expect(unique.size).toBe(3);
  });

  it("all 3 vectors use context == MEMO_KEY_CONTEXT (no drift)", () => {
    expect(VECTOR_1.context).toBe(MEMO_KEY_CONTEXT);
    expect(VECTOR_2.context).toBe(MEMO_KEY_CONTEXT);
    expect(VECTOR_3.context).toBe(MEMO_KEY_CONTEXT);
  });
});
