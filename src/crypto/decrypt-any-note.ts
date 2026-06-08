/**
 * crypto/decrypt-any-note.ts — Format-agnostic note decryption.
 *
 * Two wire formats exist in the protocol:
 *   - "v3"      used by EVM adapters (JanusFlow, JanusERC20). Fields: {v,amt,bld,memo?,tip?}.
 *               Encrypt with encryptNote / decrypt with decryptNote.
 *   - "shielded" used by Cadence-FT adapters (JanusFT). Fields: {v,a,b,d?}.
 *               Encrypt with encryptShieldedNote / decrypt with decryptShieldedNote.
 *
 * If you know which token type produced the ciphertext, use the adapter's
 * decryptIncomingNote() method — it calls the correct decoder with no fallback overhead.
 * If the token type is unknown at call-site, use decryptAnyNote() — it tries v3 first,
 * falls back to shielded, returns null if both fail.
 */

import type { Point } from "../types/commitment";
import { decryptNote } from "./note-schema";
import { decryptShieldedNote } from "./shielded-note";

/**
 * Normalized result returned by decryptAnyNote and adapter.decryptIncomingNote.
 *
 * Both formats expose amount + blinding. Optional fields:
 *   - memo   present on v3 notes that included a memo string.
 *   - data   present on shielded notes that included app-level data (same value
 *            as memo on the shielded path — callers can read either field).
 *   - tipId  present on v3 notes that included a tip identifier string.
 *   - wireFormat  diagnostic: tells you which decoder succeeded.
 */
export interface DecryptedAnyNote {
  amount: bigint;
  blinding: bigint;
  memo?: string;
  data?: string;
  tipId?: string;
  wireFormat: "v3" | "shielded";
}

/** Normalize ephPubkey input to a Point object. */
function toPoint(
  ephPubkey: { x: bigint; y: bigint } | [bigint, bigint]
): Point {
  if (Array.isArray(ephPubkey)) {
    return { x: ephPubkey[0], y: ephPubkey[1] };
  }
  return ephPubkey;
}

/** Normalize ciphertext input to Uint8Array. */
function toUint8Array(ciphertext: Uint8Array | number[]): Uint8Array {
  return ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
}

/**
 * Try to decrypt a note ciphertext without knowing its wire format.
 *
 * Attempts v3 (EVM) format first, then shielded (Cadence-FT) format.
 * Returns null if both decoders fail — caller can treat this as "not for me"
 * or as a corrupted blob.
 *
 * Use this when scanning mixed logs or when the token type is unknown.
 * When the token type is known, prefer adapter.decryptIncomingNote() instead.
 */
export async function decryptAnyNote(
  ciphertext: Uint8Array | number[],
  ephPubkey: { x: bigint; y: bigint } | [bigint, bigint],
  memoPrivKey: bigint
): Promise<DecryptedAnyNote | null> {
  const ct = toUint8Array(ciphertext);
  const pub = toPoint(ephPubkey);

  // --- Try v3 format (EVM adapters: JanusFlow, JanusERC20) ---
  try {
    const v3 = await decryptNote(ct, pub, memoPrivKey);
    return {
      amount: v3.amount,
      blinding: v3.blinding,
      memo: v3.memo,
      data: v3.memo,
      tipId: v3.tipId,
      wireFormat: "v3",
    };
  } catch {
    // v3 failed — try shielded format
  }

  // --- Try shielded format (Cadence-FT adapter: JanusFT) ---
  try {
    const sh = await decryptShieldedNote(ct, pub, memoPrivKey);
    return {
      amount: sh.amount,
      blinding: sh.blinding,
      memo: sh.data,
      data: sh.data,
      wireFormat: "shielded",
    };
  } catch {
    // Both decoders failed
  }

  return null;
}
