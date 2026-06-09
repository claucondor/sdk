/**
 * tests/unit/crypto/note-helpers.test.ts
 *
 * Round-trip encrypt/decrypt for NoteContent using the v0.8 wire format {v:1, amt, bld, memo?}.
 * Uses real circomlibjs BabyJub keypairs + real ECIES (WebCrypto / Node crypto).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { generateBabyJubKeypair } from "../../../src/crypto/babyjub-keypair";
import { encryptNote, decryptNote } from "../../../src/crypto/note-helpers";
import type { BabyJubKeypair } from "../../../src/types";

let recipientKp: BabyJubKeypair;
let senderKp: BabyJubKeypair;

beforeAll(async () => {
  // Keypair generation uses circomlibjs — one-time setup per suite
  [recipientKp, senderKp] = await Promise.all([
    generateBabyJubKeypair(),
    generateBabyJubKeypair(),
  ]);
}, 30_000);

describe("note-helpers: encryptNote / decryptNote", () => {
  it("round-trips amount and blinding without memo", async () => {
    const original = { amount: 1_000_000n, blinding: 42n };

    const enc = await encryptNote(original, recipientKp.pubkey);
    expect(enc.ciphertext).toBeInstanceOf(Uint8Array);
    expect(enc.ciphertext.length).toBeGreaterThan(0);

    const decrypted = await decryptNote(
      enc.ciphertext,
      enc.ephemeralPubkey,
      recipientKp.privkey,
    );

    expect(decrypted.amount).toBe(original.amount);
    expect(decrypted.blinding).toBe(original.blinding);
    expect(decrypted.memo).toBeUndefined();
  });

  it("round-trips amount, blinding, and memo", async () => {
    const original = { amount: 500_000n, blinding: 999_999n, memo: "hello 🌊" };

    const enc = await encryptNote(original, recipientKp.pubkey);
    const decrypted = await decryptNote(
      enc.ciphertext,
      enc.ephemeralPubkey,
      recipientKp.privkey,
    );

    expect(decrypted.amount).toBe(original.amount);
    expect(decrypted.blinding).toBe(original.blinding);
    expect(decrypted.memo).toBe(original.memo);
  });

  it("each encryption produces a unique ciphertext (non-deterministic ECIES)", async () => {
    const note = { amount: 100n, blinding: 1n };
    const enc1 = await encryptNote(note, recipientKp.pubkey);
    const enc2 = await encryptNote(note, recipientKp.pubkey);

    // Different ephemeral keys → different ciphertexts
    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);
    expect(enc1.ephemeralPubkey).not.toEqual(enc2.ephemeralPubkey);
  });

  it("encrypting to different pubkeys produces distinct ciphertexts", async () => {
    const note = { amount: 777n, blinding: 888n };
    const enc1 = await encryptNote(note, recipientKp.pubkey);
    const enc2 = await encryptNote(note, senderKp.pubkey);

    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);
  });

  it("decrypting with the wrong private key throws", async () => {
    const note = { amount: 100n, blinding: 1n };
    const enc = await encryptNote(note, recipientKp.pubkey);

    // senderKp.privkey is a different key — decryption should fail
    await expect(
      decryptNote(enc.ciphertext, enc.ephemeralPubkey, senderKp.privkey),
    ).rejects.toThrow();
  });

  it("handles zero amount", async () => {
    const note = { amount: 0n, blinding: 1234n };
    const enc = await encryptNote(note, recipientKp.pubkey);
    const dec = await decryptNote(enc.ciphertext, enc.ephemeralPubkey, recipientKp.privkey);
    expect(dec.amount).toBe(0n);
    expect(dec.blinding).toBe(1234n);
  });

  it("handles large amounts (1e27 range)", async () => {
    const large = 10n ** 27n;
    const note = { amount: large, blinding: large - 1n };
    const enc = await encryptNote(note, recipientKp.pubkey);
    const dec = await decryptNote(enc.ciphertext, enc.ephemeralPubkey, recipientKp.privkey);
    expect(dec.amount).toBe(large);
    expect(dec.blinding).toBe(large - 1n);
  });
});
