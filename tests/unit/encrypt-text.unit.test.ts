/**
 * Unit tests for ECIES memo encryption.
 *
 * Validates:
 *   - Round-trip: encrypt -> decrypt recovers original plaintext.
 *   - Wrong privkey: decrypt throws "authentication failed".
 *   - Multi-encrypt to same recipient: ciphertexts differ (fresh ephemeral).
 *   - Empty plaintext: round-trips correctly.
 *   - UTF-8 multi-byte: round-trips.
 */

import { describe, it, expect } from "vitest";
import {
  generateBabyJubKeypair,
  encryptText,
  decryptText,
} from "../../src/crypto";

describe("ECIES memo encryption (BabyJub + AES-GCM)", () => {
  it("round-trips a plaintext memo", async () => {
    const recipient = await generateBabyJubKeypair();
    const original = "the eagle has landed";
    const { ciphertext, ephemeralPubkey } = await encryptText(
      original,
      recipient.pubkey
    );
    const recovered = await decryptText(
      ciphertext,
      ephemeralPubkey,
      recipient.privkey
    );
    expect(recovered).toBe(original);
  });

  it("fails to decrypt with wrong privkey", async () => {
    const recipient = await generateBabyJubKeypair();
    const attacker = await generateBabyJubKeypair();
    const { ciphertext, ephemeralPubkey } = await encryptText(
      "for your eyes only",
      recipient.pubkey
    );
    await expect(
      decryptText(ciphertext, ephemeralPubkey, attacker.privkey)
    ).rejects.toThrow(/authentication failed/);
  });

  it("produces different ciphertexts for the same plaintext+recipient (fresh ephemeral)", async () => {
    const recipient = await generateBabyJubKeypair();
    const a = await encryptText("hello world", recipient.pubkey);
    const b = await encryptText("hello world", recipient.pubkey);
    expect(Buffer.from(a.ciphertext).toString("hex")).not.toBe(
      Buffer.from(b.ciphertext).toString("hex")
    );
    expect(a.ephemeralPubkey.x).not.toBe(b.ephemeralPubkey.x);
  });

  it("round-trips an empty plaintext", async () => {
    const recipient = await generateBabyJubKeypair();
    const { ciphertext, ephemeralPubkey } = await encryptText(
      "",
      recipient.pubkey
    );
    const recovered = await decryptText(
      ciphertext,
      ephemeralPubkey,
      recipient.privkey
    );
    expect(recovered).toBe("");
  });

  it("round-trips a multi-byte UTF-8 plaintext", async () => {
    const recipient = await generateBabyJubKeypair();
    const original = "hola mundo cifrado privado";
    const { ciphertext, ephemeralPubkey } = await encryptText(
      original,
      recipient.pubkey
    );
    const recovered = await decryptText(
      ciphertext,
      ephemeralPubkey,
      recipient.privkey
    );
    expect(recovered).toBe(original);
  });

  it("rejects a truncated ciphertext", async () => {
    const recipient = await generateBabyJubKeypair();
    const { ciphertext, ephemeralPubkey } = await encryptText(
      "needs all bytes",
      recipient.pubkey
    );
    const truncated = ciphertext.slice(0, 5);
    await expect(
      decryptText(truncated, ephemeralPubkey, recipient.privkey)
    ).rejects.toThrow(/too short/);
  });
});
