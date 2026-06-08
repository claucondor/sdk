/**
 * Unit tests for OF-7: consistent decrypt API
 *
 * Covers:
 *   1. encryptNote → decryptNote roundtrip (v3 EVM format)
 *   2. encryptShieldedNote → decryptShieldedNote roundtrip (shielded Cadence-FT format)
 *   3. decryptAnyNote recovers v3 format ciphertext
 *   4. decryptAnyNote recovers shielded format ciphertext
 *   5. decryptAnyNote returns null on garbage / mismatched key
 *   6. JanusFlowAdapter.decryptIncomingNote uses v3 path (amount + memo present)
 *   7. JanusFTAdapter.decryptIncomingNote uses shielded path (amount + data present)
 *   8. Cross-decoder: decryptNote on a shielded ciphertext does not crash — throws gracefully
 */

import { describe, it, expect } from "vitest";
import { encryptNote, decryptNote } from "../../src/crypto/note-schema";
import { encryptShieldedNote, decryptShieldedNote } from "../../src/crypto/shielded-note";
import { decryptAnyNote } from "../../src/crypto/decrypt-any-note";
import { generateBabyJubKeypair } from "../../src/crypto/babyjub-keypair";
import { JanusFlowAdapter } from "../../src/adapters/janus-flow";
import { JanusFTAdapter } from "../../src/adapters/janus-ft";
import { TOKEN_REGISTRY } from "../../src/network/contracts";

const TEST_AMOUNT = 500_000_000_000_000_000n; // 0.5 FLOW in wei
const TEST_BLINDING = 1234567890n;
const TEST_MEMO = "test memo OF-7";
const TEST_TIP_ID = "tip-xyz-001";
const TEST_DATA = "cadence-app-payload";

describe("OF-7 — decrypt-any-note", () => {
  // ─── Test 1: encryptNote → decryptNote roundtrip ──────────────────────────
  it("Test 1: encryptNote → decryptNote roundtrip recovers all fields", async () => {
    const keypair = await generateBabyJubKeypair();
    const note = {
      amount: TEST_AMOUNT,
      blinding: TEST_BLINDING,
      memo: TEST_MEMO,
      tipId: TEST_TIP_ID,
    };
    const enc = await encryptNote(note, keypair.pubkey);
    const dec = await decryptNote(enc.ciphertext, enc.ephemeralPubkey, keypair.privkey);
    expect(dec.amount).toBe(note.amount);
    expect(dec.blinding).toBe(note.blinding);
    expect(dec.memo).toBe(TEST_MEMO);
    expect(dec.tipId).toBe(TEST_TIP_ID);
  });

  // ─── Test 2: encryptShieldedNote → decryptShieldedNote roundtrip ──────────
  it("Test 2: encryptShieldedNote → decryptShieldedNote roundtrip recovers all fields", async () => {
    const keypair = await generateBabyJubKeypair();
    const note = {
      amount: TEST_AMOUNT,
      blinding: TEST_BLINDING,
      data: TEST_DATA,
    };
    const enc = await encryptShieldedNote(note, keypair.pubkey);
    const dec = await decryptShieldedNote(enc.ciphertext, enc.ephemeralPubkey, keypair.privkey);
    expect(dec.amount).toBe(note.amount);
    expect(dec.blinding).toBe(note.blinding);
    expect(dec.data).toBe(TEST_DATA);
  });

  // ─── Test 3: decryptAnyNote recovers v3 format ────────────────────────────
  it("Test 3: decryptAnyNote recovers v3 ciphertext with wireFormat=v3", async () => {
    const keypair = await generateBabyJubKeypair();
    const note = { amount: TEST_AMOUNT, blinding: TEST_BLINDING, memo: TEST_MEMO, tipId: TEST_TIP_ID };
    const enc = await encryptNote(note, keypair.pubkey);

    const result = await decryptAnyNote(enc.ciphertext, enc.ephemeralPubkey, keypair.privkey);

    expect(result).not.toBeNull();
    expect(result!.wireFormat).toBe("v3");
    expect(result!.amount).toBe(TEST_AMOUNT);
    expect(result!.blinding).toBe(TEST_BLINDING);
    expect(result!.memo).toBe(TEST_MEMO);
    expect(result!.tipId).toBe(TEST_TIP_ID);
  });

  // ─── Test 4: decryptAnyNote recovers shielded format ─────────────────────
  it("Test 4: decryptAnyNote recovers shielded ciphertext with wireFormat=shielded", async () => {
    const keypair = await generateBabyJubKeypair();
    const note = { amount: TEST_AMOUNT, blinding: TEST_BLINDING, data: TEST_DATA };
    const enc = await encryptShieldedNote(note, keypair.pubkey);

    const result = await decryptAnyNote(enc.ciphertext, enc.ephemeralPubkey, keypair.privkey);

    expect(result).not.toBeNull();
    expect(result!.wireFormat).toBe("shielded");
    expect(result!.amount).toBe(TEST_AMOUNT);
    expect(result!.blinding).toBe(TEST_BLINDING);
    expect(result!.data).toBe(TEST_DATA);
    // memo is aliased to data on the shielded path
    expect(result!.memo).toBe(TEST_DATA);
  });

  // ─── Test 5: decryptAnyNote returns null on wrong key ─────────────────────
  it("Test 5: decryptAnyNote returns null when memoPrivKey doesn't match", async () => {
    const alice = await generateBabyJubKeypair();
    const bob = await generateBabyJubKeypair();

    const note = { amount: TEST_AMOUNT, blinding: TEST_BLINDING };
    const enc = await encryptNote(note, alice.pubkey);

    // bob's privkey cannot decrypt alice's ciphertext
    const result = await decryptAnyNote(enc.ciphertext, enc.ephemeralPubkey, bob.privkey);
    expect(result).toBeNull();
  });

  // ─── Test 6: JanusFlowAdapter.decryptIncomingNote uses v3 path ────────────
  it("Test 6: JanusFlowAdapter.decryptIncomingNote decrypts v3 note (amount + memo)", async () => {
    const flowEntry = TOKEN_REGISTRY["flow"];
    const adapter = new JanusFlowAdapter("flow", flowEntry);

    const keypair = await generateBabyJubKeypair();
    const note = { amount: TEST_AMOUNT, blinding: TEST_BLINDING, memo: TEST_MEMO };
    const enc = await encryptNote(note, keypair.pubkey);

    const result = await adapter.decryptIncomingNote(
      enc.ciphertext,
      enc.ephemeralPubkey,
      keypair.privkey
    );

    expect(result).not.toBeNull();
    expect(result!.amount).toBe(TEST_AMOUNT);
    expect(result!.blinding).toBe(TEST_BLINDING);
    expect(result!.memo).toBe(TEST_MEMO);
    expect(result!.wireFormat).toBe("v3");
  });

  // ─── Test 7: JanusFTAdapter.decryptIncomingNote uses shielded path ─────────
  it("Test 7: JanusFTAdapter.decryptIncomingNote decrypts shielded note (amount + data)", async () => {
    const ftEntry = TOKEN_REGISTRY["mockft"];
    const adapter = new JanusFTAdapter("mockft", ftEntry);

    const keypair = await generateBabyJubKeypair();
    const note = { amount: TEST_AMOUNT, blinding: TEST_BLINDING, data: TEST_DATA };
    const enc = await encryptShieldedNote(note, keypair.pubkey);

    const result = await adapter.decryptIncomingNote(
      enc.ciphertext,
      enc.ephemeralPubkey,
      keypair.privkey
    );

    expect(result).not.toBeNull();
    expect(result!.amount).toBe(TEST_AMOUNT);
    expect(result!.blinding).toBe(TEST_BLINDING);
    expect(result!.data).toBe(TEST_DATA);
    expect(result!.wireFormat).toBe("shielded");
  });

  // ─── Test 8: Cross-decoder: decryptNote on shielded ciphertext throws ─────
  it("Test 8: decryptNote on shielded-format ciphertext throws (not crash) and returns null via adapter", async () => {
    const keypair = await generateBabyJubKeypair();
    const shieldedNote = { amount: TEST_AMOUNT, blinding: TEST_BLINDING, data: TEST_DATA };
    const enc = await encryptShieldedNote(shieldedNote, keypair.pubkey);

    // decryptNote should throw (wrong format), not hang or segfault
    await expect(
      decryptNote(enc.ciphertext, enc.ephemeralPubkey, keypair.privkey)
    ).rejects.toThrow();

    // JanusFlowAdapter.decryptIncomingNote should return null (not throw) on cross-format ciphertext
    const flowEntry = TOKEN_REGISTRY["flow"];
    const flowAdapter = new JanusFlowAdapter("flow", flowEntry);
    const crossResult = await flowAdapter.decryptIncomingNote(
      enc.ciphertext,
      enc.ephemeralPubkey,
      keypair.privkey
    );
    expect(crossResult).toBeNull();
  });
});
