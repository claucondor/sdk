/**
 * Unit tests for ECIES encrypt/decrypt (BabyJub + AES-GCM).
 * Tests: encrypt(A→B) decryptable by B, not by A. Forward secrecy.
 */

import { describe, it, expect } from "vitest";
import { encryptText } from "../../src/crypto/encrypt-text";
import { decryptText } from "../../src/crypto/decrypt-text";
import { generateBabyJubKeypair } from "../../src/crypto/babyjub-keypair";

describe("ECDH encrypt/decrypt — BabyJub ECIES", () => {
  it("message encrypted to B can be decrypted by B's privkey", async () => {
    const alice = await generateBabyJubKeypair();
    const bob = await generateBabyJubKeypair();
    const plaintext = "hello from alice";
    const { ciphertext, ephemeralPubkey } = await encryptText(plaintext, bob.pubkey);
    const decrypted = await decryptText(ciphertext, ephemeralPubkey, bob.privkey);
    expect(decrypted).toBe(plaintext);
  });

  it("message encrypted to B CANNOT be decrypted by A's privkey", async () => {
    const alice = await generateBabyJubKeypair();
    const bob = await generateBabyJubKeypair();
    const { ciphertext, ephemeralPubkey } = await encryptText("secret", bob.pubkey);
    await expect(decryptText(ciphertext, ephemeralPubkey, alice.privkey)).rejects.toThrow();
  });

  it("forward secrecy: two encryptions of same plaintext+recipient use different ephemerals", async () => {
    const bob = await generateBabyJubKeypair();
    const enc1 = await encryptText("hello", bob.pubkey);
    const enc2 = await encryptText("hello", bob.pubkey);
    expect(enc1.ephemeralPubkey.x).not.toBe(enc2.ephemeralPubkey.x);
    expect(enc1.ephemeralPubkey.y).not.toBe(enc2.ephemeralPubkey.y);
  });

  it("forward secrecy: two sends to same recipient have different ciphertexts", async () => {
    const bob = await generateBabyJubKeypair();
    const enc1 = await encryptText("same message", bob.pubkey);
    const enc2 = await encryptText("same message", bob.pubkey);
    expect(Buffer.from(enc1.ciphertext).toString("hex")).not.toBe(
      Buffer.from(enc2.ciphertext).toString("hex")
    );
  });

  it("empty plaintext roundtrips correctly", async () => {
    const bob = await generateBabyJubKeypair();
    const { ciphertext, ephemeralPubkey } = await encryptText("", bob.pubkey);
    const dec = await decryptText(ciphertext, ephemeralPubkey, bob.privkey);
    expect(dec).toBe("");
  });

  it("multi-byte UTF-8 (emoji) roundtrips correctly", async () => {
    const bob = await generateBabyJubKeypair();
    const msg = "tip 🌊 5 FLOW";
    const { ciphertext, ephemeralPubkey } = await encryptText(msg, bob.pubkey);
    const dec = await decryptText(ciphertext, ephemeralPubkey, bob.privkey);
    expect(dec).toBe(msg);
  });
});
