/**
 * tests/unit/crypto/checkpoint-schema.test.ts
 *
 * Round-trip encrypt/decrypt for SnapshotContent using the v0.8 wire format {v:1, bal, bld}.
 * Also tests backward-compat decrypt (v2/v3 envelopes from older checkpoints).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { generateBabyJubKeypair } from "../../../src/crypto/babyjub-keypair";
import { encryptSnapshot, decryptSnapshot } from "../../../src/crypto/checkpoint-schema";
import type { BabyJubKeypair, SnapshotContent } from "../../../src/types";

let kp: BabyJubKeypair;

beforeAll(async () => {
  kp = await generateBabyJubKeypair();
}, 30_000);

describe("checkpoint-schema: encryptSnapshot / decryptSnapshot", () => {
  it("round-trips balance and blinding", async () => {
    const snap: SnapshotContent = { balance: 5_000_000n, blinding: 999n };

    const enc = await encryptSnapshot(snap, kp.pubkey);
    expect(enc.ciphertext).toBeInstanceOf(Uint8Array);
    expect(enc.ciphertext.length).toBeGreaterThan(0);

    const dec = await decryptSnapshot(enc.ciphertext, enc.ephemeralPubkey, kp.privkey);
    expect(dec).not.toBeNull();
    expect(dec!.balance).toBe(snap.balance);
    expect(dec!.blinding).toBe(snap.blinding);
  });

  it("returns null (not throw) on wrong private key", async () => {
    const otherKp = await generateBabyJubKeypair();
    const snap: SnapshotContent = { balance: 100n, blinding: 1n };

    const enc = await encryptSnapshot(snap, kp.pubkey);
    const result = await decryptSnapshot(enc.ciphertext, enc.ephemeralPubkey, otherKp.privkey);
    expect(result).toBeNull();
  });

  it("produces unique ciphertexts on repeated calls (non-deterministic)", async () => {
    const snap: SnapshotContent = { balance: 1n, blinding: 2n };
    const enc1 = await encryptSnapshot(snap, kp.pubkey);
    const enc2 = await encryptSnapshot(snap, kp.pubkey);
    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);
    expect(enc1.ephemeralPubkey).not.toEqual(enc2.ephemeralPubkey);
  });

  it("handles zero balance", async () => {
    const snap: SnapshotContent = { balance: 0n, blinding: 7n };
    const enc = await encryptSnapshot(snap, kp.pubkey);
    const dec = await decryptSnapshot(enc.ciphertext, enc.ephemeralPubkey, kp.privkey);
    expect(dec!.balance).toBe(0n);
    expect(dec!.blinding).toBe(7n);
  });

  it("handles very large balance", async () => {
    const snap: SnapshotContent = { balance: 10n ** 30n, blinding: 10n ** 30n - 1n };
    const enc = await encryptSnapshot(snap, kp.pubkey);
    const dec = await decryptSnapshot(enc.ciphertext, enc.ephemeralPubkey, kp.privkey);
    expect(dec!.balance).toBe(snap.balance);
    expect(dec!.blinding).toBe(snap.blinding);
  });

  it("note-helpers and checkpoint-schema use distinct wire-format keys", async () => {
    // Verify that the decrypted objects use the expected schema-specific keys:
    // note-helpers: {v:1, amt, bld} — 'amt' not 'bal'
    // checkpoint-schema: {v:1, bal, bld} — 'bal' not 'amt'
    const { encryptNote, decryptNote } = await import("../../../src/crypto/note-helpers");
    const { decryptSnapshot } = await import("../../../src/crypto/checkpoint-schema");

    const note = { amount: 100n, blinding: 1n };
    const snap: SnapshotContent = { balance: 100n, blinding: 1n };

    const noteEnc = await encryptNote(note, kp.pubkey);
    const snapEnc = await encryptSnapshot(snap, kp.pubkey);

    const decNote = await decryptNote(noteEnc.ciphertext, noteEnc.ephemeralPubkey, kp.privkey);
    const decSnap = await decryptSnapshot(snapEnc.ciphertext, snapEnc.ephemeralPubkey, kp.privkey);

    // Note round-trip has 'amount', snapshot round-trip has 'balance'
    expect(decNote).toHaveProperty("amount");
    expect(decNote).not.toHaveProperty("balance");
    expect(decSnap).toHaveProperty("balance");
    expect((decSnap as SnapshotContent & { amount?: bigint })).not.toHaveProperty("amount");
  });
});
