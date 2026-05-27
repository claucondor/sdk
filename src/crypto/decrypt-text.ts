/**
 * crypto/decrypt-text.ts — BabyJub ECIES + AES-GCM text decryption.
 *
 * Counterpart to encryptText. Recovers the original UTF-8 plaintext given:
 *   - the ciphertext blob (iv || ct || tag) emitted by encryptText,
 *   - the ephemeralPubkey emitted by encryptText, and
 *   - the recipient's BabyJubJub private scalar.
 *
 * Construction (mirrors encryptText):
 *   1. shared = recipient_privkey * ephemeralPubkey  (ECDH on subgroup).
 *   2. key = HKDF-SHA256(shared, salt = "openjanus/memo/v1"), 32 bytes.
 *   3. iv = ciphertext[0..12]; ct||tag = ciphertext[12..].
 *   4. plaintext = AES-256-GCM decrypt — throws on auth tag mismatch.
 *
 * Error modes:
 *   - Wrong privkey: HKDF derives a different key, AES-GCM authentication
 *     fails, this function throws "decryptText: authentication failed".
 *   - Truncated ciphertext: throws "decryptText: ciphertext too short".
 *   - Tampered ciphertext: AES-GCM tag mismatch, throws as above.
 */

import type { Point } from "../types/commitment";
import { computeSharedSecret } from "./babyjub-keypair";

const HKDF_SALT = new TextEncoder().encode("openjanus/memo/v1");
const AES_GCM_IV_LEN = 12;
const AES_GCM_TAG_LEN = 16;

async function getCrypto(): Promise<Crypto> {
  if (typeof globalThis !== "undefined" && (globalThis as { crypto?: Crypto }).crypto) {
    return (globalThis as { crypto: Crypto }).crypto;
  }
  const nodeCrypto = (await import("crypto")) as unknown as { webcrypto: Crypto };
  return nodeCrypto.webcrypto;
}

function fieldElementTo32Bytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  if (hex.length > 64) {
    throw new Error("fieldElementTo32Bytes: value exceeds 256 bits");
  }
  hex = hex.padStart(64, "0");
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function deriveAesKey(sharedSecretX: bigint): Promise<CryptoKey> {
  const crypto = await getCrypto();
  const ikm = fieldElementTo32Bytes(sharedSecretX);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    ikm as unknown as ArrayBuffer,
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT as unknown as ArrayBuffer,
      info: new Uint8Array(0) as unknown as ArrayBuffer,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Decrypt a memo ciphertext using the recipient's private key.
 *
 * @param ciphertext      iv || ct || tag (as produced by encryptText).
 * @param ephemeralPubkey Sender's ephemeral pubkey for ECDH derivation.
 * @param privkey         Recipient's BabyJubJub private scalar.
 * @returns               UTF-8 plaintext string.
 */
export async function decryptText(
  ciphertext: Uint8Array,
  ephemeralPubkey: Point,
  privkey: bigint
): Promise<string> {
  if (ciphertext.length < AES_GCM_IV_LEN + AES_GCM_TAG_LEN) {
    throw new Error(
      `decryptText: ciphertext too short (${ciphertext.length} bytes; need at least ${AES_GCM_IV_LEN + AES_GCM_TAG_LEN})`
    );
  }

  const shared = await computeSharedSecret(privkey, ephemeralPubkey);
  const key = await deriveAesKey(shared);

  const iv = ciphertext.slice(0, AES_GCM_IV_LEN);
  const ctAndTag = ciphertext.slice(AES_GCM_IV_LEN);

  const crypto = await getCrypto();
  let plaintextBytes: Uint8Array;
  try {
    plaintextBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as unknown as ArrayBuffer },
        key,
        ctAndTag as unknown as ArrayBuffer
      )
    );
  } catch {
    throw new Error(
      "decryptText: authentication failed (wrong key, tampered ciphertext, or corrupted frame)"
    );
  }

  return new TextDecoder().decode(plaintextBytes);
}
