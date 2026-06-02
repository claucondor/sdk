/**
 * Unit tests for note-schema.ts
 * Tests: roundtrip encode/decode, all fields preserved, optional fields.
 */

import { describe, it, expect } from "vitest";
import { encryptNote, decryptNote } from "../../src/crypto/note-schema";
import { generateBabyJubKeypair } from "../../src/crypto/babyjub-keypair";

describe("note-schema — roundtrip", () => {
  it("roundtrip with all fields", async () => {
    const keypair = await generateBabyJubKeypair();
    const note = {
      amount: 2_000_000_000_000_000_000n,
      blinding: 99887766554433221100n,
      memo: "tip native FLOW",
      tipId: "tip-abc-123",
    };
    const enc = await encryptNote(note, keypair.pubkey);
    const dec = await decryptNote(enc.ciphertext, enc.ephemeralPubkey, keypair.privkey);
    expect(dec.amount).toBe(note.amount);
    expect(dec.blinding).toBe(note.blinding);
    expect(dec.memo).toBe(note.memo);
    expect(dec.tipId).toBe(note.tipId);
  });

  it("roundtrip without optional fields", async () => {
    const keypair = await generateBabyJubKeypair();
    const note = { amount: 100n, blinding: 42n };
    const enc = await encryptNote(note, keypair.pubkey);
    const dec = await decryptNote(enc.ciphertext, enc.ephemeralPubkey, keypair.privkey);
    expect(dec.amount).toBe(100n);
    expect(dec.blinding).toBe(42n);
    expect(dec.memo).toBeUndefined();
    expect(dec.tipId).toBeUndefined();
  });

  it("roundtrip with empty memo string", async () => {
    const keypair = await generateBabyJubKeypair();
    const note = { amount: 1n, blinding: 1n, memo: "" };
    const enc = await encryptNote(note, keypair.pubkey);
    const dec = await decryptNote(enc.ciphertext, enc.ephemeralPubkey, keypair.privkey);
    expect(dec.memo).toBe("");
  });

  it("throws with wrong privkey", async () => {
    const keypairA = await generateBabyJubKeypair();
    const keypairB = await generateBabyJubKeypair();
    const note = { amount: 100n, blinding: 42n };
    const enc = await encryptNote(note, keypairA.pubkey);
    await expect(
      decryptNote(enc.ciphertext, enc.ephemeralPubkey, keypairB.privkey)
    ).rejects.toThrow();
  });

  it("preserves large bigint amounts", async () => {
    const keypair = await generateBabyJubKeypair();
    const note = {
      amount: (1n << 127n) - 1n,
      blinding: (1n << 127n) + 1n,
    };
    const enc = await encryptNote(note, keypair.pubkey);
    const dec = await decryptNote(enc.ciphertext, enc.ephemeralPubkey, keypair.privkey);
    expect(dec.amount).toBe(note.amount);
    expect(dec.blinding).toBe(note.blinding);
  });

  it("each encryption uses a unique ephemeral (forward secrecy)", async () => {
    const keypair = await generateBabyJubKeypair();
    const note = { amount: 100n, blinding: 42n };
    const enc1 = await encryptNote(note, keypair.pubkey);
    const enc2 = await encryptNote(note, keypair.pubkey);
    expect(enc1.ephemeralPubkey.x).not.toBe(enc2.ephemeralPubkey.x);
  });
});
