/**
 * Unit tests for recovery/snapshot.ts — encrypt/decrypt roundtrip.
 */

import { describe, it, expect } from "vitest";
import { generateBabyJubKeypair } from "../../crypto/babyjub-keypair";
import { encryptSnapshotToSelf, decryptSnapshot } from "../snapshot";

describe("recovery/snapshot — encrypt/decrypt roundtrip", () => {
  it("encrypts and decrypts a snapshot successfully", async () => {
    const kp = await generateBabyJubKeypair();
    const snapshot = { balance: 1_000_000_000_000_000_000n, blinding: 12345678901234567890n };

    const { ciphertext, ephPubkey } = await encryptSnapshotToSelf(snapshot, kp.pubkey);
    const decrypted = await decryptSnapshot(ciphertext, ephPubkey, kp.privkey);

    expect(decrypted).not.toBeNull();
    expect(decrypted!.balance).toBe(snapshot.balance);
    expect(decrypted!.blinding).toBe(snapshot.blinding);
  });

  it("returns null when decryption is attempted with wrong privkey", async () => {
    const kp = await generateBabyJubKeypair();
    const kpWrong = await generateBabyJubKeypair();
    const snapshot = { balance: 500n, blinding: 999n };

    const { ciphertext, ephPubkey } = await encryptSnapshotToSelf(snapshot, kp.pubkey);
    const decrypted = await decryptSnapshot(ciphertext, ephPubkey, kpWrong.privkey);

    expect(decrypted).toBeNull();
  });

  it("roundtrip with zero balance and zero blinding", async () => {
    const kp = await generateBabyJubKeypair();
    const snapshot = { balance: 0n, blinding: 0n };

    const { ciphertext, ephPubkey } = await encryptSnapshotToSelf(snapshot, kp.pubkey);
    const decrypted = await decryptSnapshot(ciphertext, ephPubkey, kp.privkey);

    expect(decrypted).not.toBeNull();
    expect(decrypted!.balance).toBe(0n);
    expect(decrypted!.blinding).toBe(0n);
  });

  it("roundtrip with large bigint values", async () => {
    const kp = await generateBabyJubKeypair();
    // Large but still < 2^128
    const snapshot = {
      balance: (1n << 120n) - 1n,
      blinding: (1n << 127n) - 3n,
    };

    const { ciphertext, ephPubkey } = await encryptSnapshotToSelf(snapshot, kp.pubkey);
    const decrypted = await decryptSnapshot(ciphertext, ephPubkey, kp.privkey);

    expect(decrypted).not.toBeNull();
    expect(decrypted!.balance).toBe(snapshot.balance);
    expect(decrypted!.blinding).toBe(snapshot.blinding);
  });
});
