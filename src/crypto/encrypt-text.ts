/**
 * crypto/encrypt-text.ts — BabyJub ECIES + AES-GCM text encryption.
 *
 * Provides ECIES (Elliptic Curve Integrated Encryption Scheme) over BabyJubJub
 * for short text payloads (e.g. tip memos, message attachments). The scheme
 * is generic: any caller with a recipient's pubkey can produce a ciphertext
 * that only the corresponding privkey holder can decrypt.
 *
 * Construction:
 *   1. Generate fresh ephemeral keypair (eph_priv, eph_pub).
 *   2. shared = eph_priv * recipient_pubkey  (32-byte BabyJub x-coordinate).
 *   3. key = HKDF-SHA256(shared, salt = "openjanus/memo/v1", info = ""), 32 bytes.
 *   4. iv = random 12 bytes (AES-GCM nonce).
 *   5. ciphertext = AES-256-GCM(key, iv, plaintext); 16-byte tag appended.
 *   6. Output: ciphertext bytes (iv || ct || tag) + eph_pub for transport.
 *
 * Encoding for on-chain storage:
 *   - `ciphertext` is a Uint8Array. To store on Cadence as [UInt8] convert
 *     directly. To store on EVM as bytes pass through ethers.hexlify.
 *   - `ephemeralPubkey` is a Point (x, y bigints). Store as 2x UInt256 / 2x
 *     uint256 — both halves are needed by the recipient to compute ECDH.
 *
 * Threat model:
 *   - Confidentiality: only the holder of the recipient's privkey can decrypt.
 *     ECDH on BabyJubJub subgroup; AES-GCM authenticated encryption.
 *   - Integrity: AES-GCM tag covers ciphertext but NOT associated data (we
 *     pass no AAD). Callers wanting to bind ciphertext to e.g. a tip-id
 *     should pre-hash that into the plaintext.
 *   - Forward secrecy: each call uses a fresh ephemeral, so leaking one
 *     recipient privkey only exposes ciphertexts sent to THAT recipient
 *     (not ciphertexts sent to other recipients with the same privkey).
 *   - The ephemeral pubkey is sent in the clear — this is fine; it has no
 *     meaning without the recipient's privkey.
 *
 * NON-GOAL: not for large payloads. AES-GCM has a 64GB single-key limit, but
 * the more pressing concern is on-chain storage cost — keep memos under ~2 KB.
 */

import type { Point } from "../types/commitment";
import {
  generateBabyJubKeypair,
  computeSharedSecret,
} from "./babyjub-keypair";

/** HKDF salt — versioned so future schemes can coexist. */
const HKDF_SALT = new TextEncoder().encode("openjanus/memo/v1");

/** AES-GCM nonce length in bytes (NIST SP 800-38D recommended). */
const AES_GCM_IV_LEN = 12;

/** Resulting ciphertext frame: ciphertext blob + transport pubkey. */
export interface MemoCiphertext {
  /** ciphertext = iv (12B) || ct || tag (16B). Pass to decryptText as-is. */
  ciphertext: Uint8Array;
  /** Ephemeral pubkey for ECDH on the receiver side. */
  ephemeralPubkey: Point;
}

// ---------------------------------------------------------------------------
// Internal helpers — HKDF-SHA256 derivation using Node webcrypto
// ---------------------------------------------------------------------------

async function getCrypto(): Promise<Crypto> {
  if (typeof globalThis !== "undefined" && (globalThis as { crypto?: Crypto }).crypto) {
    return (globalThis as { crypto: Crypto }).crypto;
  }
  // Node <19 fallback (Node 18+ has webcrypto on globalThis).
  const nodeCrypto = (await import("crypto")) as unknown as { webcrypto: Crypto };
  return nodeCrypto.webcrypto;
}

/**
 * Serialize a BabyJub field element to a fixed 32-byte big-endian blob —
 * the canonical wire format for the shared-secret ECDH x-coordinate.
 */
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

/**
 * Derive a 32-byte AES key from the ECDH shared secret via HKDF-SHA256.
 */
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt a UTF-8 text payload to `recipientPubkey`.
 *
 * @param plaintext       Cleartext UTF-8 message (e.g. tip memo).
 * @param recipientPubkey BabyJubJub public key of the recipient.
 * @returns {ciphertext, ephemeralPubkey} — both required for decryption.
 */
export async function encryptText(
  plaintext: string,
  recipientPubkey: Point
): Promise<MemoCiphertext> {
  if (plaintext.length === 0) {
    // Allow empty memos — produces a tiny tag-only blob that's still
    // distinguishable from "no ciphertext at all".
  }

  // 1. Fresh ephemeral keypair.
  const ephemeral = await generateBabyJubKeypair();

  // 2. ECDH shared secret (x-coordinate).
  const shared = await computeSharedSecret(ephemeral.privkey, recipientPubkey);

  // 3. HKDF -> AES-256 key.
  const key = await deriveAesKey(shared);

  // 4. Random IV + AES-GCM encrypt.
  const crypto = await getCrypto();
  const iv = new Uint8Array(AES_GCM_IV_LEN);
  crypto.getRandomValues(iv);
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as unknown as ArrayBuffer },
      key,
      plaintextBytes as unknown as ArrayBuffer
    )
  );

  // 5. Frame: iv || ct||tag.
  const ciphertext = new Uint8Array(AES_GCM_IV_LEN + encrypted.length);
  ciphertext.set(iv, 0);
  ciphertext.set(encrypted, AES_GCM_IV_LEN);

  return {
    ciphertext,
    ephemeralPubkey: ephemeral.pubkey,
  };
}
