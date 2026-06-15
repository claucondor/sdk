/**
 * crypto/decrypt-any-note.ts — ECIES note decryption helpers.
 *
 * v0.8: A single canonical wire format exists — {v:1, amt, bld, memo?} encoded
 * in note-helpers.ts. The legacy {v,a,b,d} "shielded" format from JanusFT v0.6
 * is dropped because JanusFT v0.8 now uses the same note-helpers format.
 *
 * decryptAnyNote() tries the canonical v1 format first. Apps with custom
 * schemas should call decryptText() directly and parse their own payload.
 *
 * decryptInboxNote() handles a ShieldedInbox.Note struct (as returned by
 * drainBatch / drainAll / peek) — wraps decryptAnyNote with convenient
 * note-struct input shape.
 */

import type { Point } from "../types/commitment";
import type { InboxNote, NoteContent } from "../types";
import { decryptNote } from "./note-helpers";

/**
 * Normalized decryption result.
 *
 * wireFormat is always "v1" in v0.8.
 * tipId is not part of the protocol note schema; apps that need it should
 * extend NoteContent locally.
 */
export interface DecryptedAnyNote {
  amount: bigint;
  blinding: bigint;
  memo?: string;
  /** Alias for memo — present for backward compatibility with v0.7 callers. */
  data?: string;
  wireFormat: "v1";
}

/** Normalize ephPubkey to a Point object. */
function toPoint(
  ephPubkey: { x: bigint; y: bigint } | [bigint, bigint]
): Point {
  if (Array.isArray(ephPubkey)) {
    return { x: ephPubkey[0], y: ephPubkey[1] };
  }
  return ephPubkey;
}

/** Normalize ciphertext to Uint8Array. */
function toUint8Array(ciphertext: Uint8Array | number[]): Uint8Array {
  return ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
}

/**
 * Decrypt a note ciphertext.
 * Returns null if decryption fails (wrong key or corrupt ciphertext).
 * Use adapter.decryptIncomingNote() if the token type is known — it is faster.
 */
export async function decryptAnyNote(
  ciphertext: Uint8Array | number[],
  ephPubkey: { x: bigint; y: bigint } | [bigint, bigint],
  memoPrivKey: bigint
): Promise<DecryptedAnyNote | null> {
  const ct = toUint8Array(ciphertext);
  const pub = toPoint(ephPubkey);

  try {
    const note = await decryptNote(ct, pub, memoPrivKey);
    return {
      amount: note.amount,
      blinding: note.blinding,
      memo: note.memo,
      data: note.memo,
      wireFormat: "v1",
    };
  } catch {
    return null;
  }
}

/**
 * Decrypt a ShieldedInbox note using the recipient's memo private key.
 *
 * @param note      Note struct from ShieldedInbox.drainBatch / drainAll / peek.
 * @param privkey   Recipient's BabyJub memo private key.
 * @returns         Decrypted NoteContent, or null if decryption fails.
 */
export async function decryptInboxNote(
  note: InboxNote,
  privkey: bigint
): Promise<NoteContent | null> {
  try {
    return await decryptNote(
      note.ciphertext,
      { x: note.ephPubkeyX, y: note.ephPubkeyY },
      privkey
    );
  } catch {
    return null;
  }
}
