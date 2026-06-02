/**
 * Unit tests for snapshot-schema.ts
 * Tests: roundtrip encode/decode, timestamp unit is ALWAYS ms, null on bad key.
 */

import { describe, it, expect } from "vitest";
import { encryptSnapshot, decryptSnapshot } from "../../src/crypto/snapshot-schema";
import { generateBabyJubKeypair } from "../../src/crypto/babyjub-keypair";
import { SNAPSHOT_TIMESTAMP_UNIT } from "../../src/types";

describe("snapshot-schema — roundtrip", () => {
  it("SNAPSHOT_TIMESTAMP_UNIT is 'ms'", () => {
    expect(SNAPSHOT_TIMESTAMP_UNIT).toBe("ms");
  });

  it("roundtrip: encrypt → decrypt preserves all fields", async () => {
    const keypair = await generateBabyJubKeypair();
    const snapshot = {
      balance: 4_995_000_000_000_000_000n,
      blinding: 12345678901234567890123456789012n,
      timestampMs: Date.now(),
    };
    const enc = await encryptSnapshot(snapshot, keypair.pubkey);
    const dec = await decryptSnapshot(enc.ciphertext, enc.ephemeralPubkey, keypair.privkey);
    expect(dec).not.toBeNull();
    expect(dec!.balance).toBe(snapshot.balance);
    expect(dec!.blinding).toBe(snapshot.blinding);
    expect(dec!.timestampMs).toBe(snapshot.timestampMs);
  });

  it("roundtrip with zero balance and zero blinding", async () => {
    const keypair = await generateBabyJubKeypair();
    const snapshot = { balance: 0n, blinding: 0n, timestampMs: 0 };
    const enc = await encryptSnapshot(snapshot, keypair.pubkey);
    const dec = await decryptSnapshot(enc.ciphertext, enc.ephemeralPubkey, keypair.privkey);
    expect(dec!.balance).toBe(0n);
    expect(dec!.blinding).toBe(0n);
    expect(dec!.timestampMs).toBe(0);
  });

  it("roundtrip with large bigint values (near 2^128)", async () => {
    const keypair = await generateBabyJubKeypair();
    const snapshot = {
      balance: (1n << 127n) - 1n,
      blinding: (1n << 127n) + 99n,
      timestampMs: Date.now(),
    };
    const enc = await encryptSnapshot(snapshot, keypair.pubkey);
    const dec = await decryptSnapshot(enc.ciphertext, enc.ephemeralPubkey, keypair.privkey);
    expect(dec!.balance).toBe(snapshot.balance);
    expect(dec!.blinding).toBe(snapshot.blinding);
  });

  it("returns null when decrypted with wrong privkey", async () => {
    const keypairA = await generateBabyJubKeypair();
    const keypairB = await generateBabyJubKeypair();
    const snapshot = { balance: 100n, blinding: 42n, timestampMs: 1000 };
    const enc = await encryptSnapshot(snapshot, keypairA.pubkey);
    const dec = await decryptSnapshot(enc.ciphertext, enc.ephemeralPubkey, keypairB.privkey);
    expect(dec).toBeNull();
  });

  it("returns null for truncated ciphertext", async () => {
    const keypair = await generateBabyJubKeypair();
    const snapshot = { balance: 1n, blinding: 1n, timestampMs: 1 };
    const enc = await encryptSnapshot(snapshot, keypair.pubkey);
    const truncated = enc.ciphertext.slice(0, 5);
    const dec = await decryptSnapshot(truncated, enc.ephemeralPubkey, keypair.privkey);
    expect(dec).toBeNull();
  });

  it("each encryption produces unique ciphertext (fresh ephemeral)", async () => {
    const keypair = await generateBabyJubKeypair();
    const snapshot = { balance: 100n, blinding: 200n, timestampMs: 1000 };
    const enc1 = await encryptSnapshot(snapshot, keypair.pubkey);
    const enc2 = await encryptSnapshot(snapshot, keypair.pubkey);
    // Different ephemeral pubkeys → different ciphertexts
    expect(enc1.ephemeralPubkey.x).not.toBe(enc2.ephemeralPubkey.x);
  });
});
