/**
 * crypto/note-schema.ts — Note encode/decode (sender-to-recipient ECIES blob).
 *
 * A note is a sender-to-recipient encrypted blob that carries the (amount,
 * blinding) pair the recipient needs to later spend or unwrap their incoming
 * shielded credit. An optional UTF-8 memo and tipId are also carried.
 *
 * Wire format (JSON inside ECIES envelope):
 *   {"v":1,"amt":"<decimal>","bld":"<decimal>","memo":"...","tip":"..."}
 *
 * "memo" and "tip" are optional — omit from wire if undefined to keep
 * the payload compact.
 */

import { encryptText, type MemoCiphertext } from "./encrypt-text";
import { decryptText } from "./decrypt-text";
import type { NoteContent } from "../types";
import type { Point } from "../types/commitment";

const NOTE_VERSION = 1;

interface NoteWire {
  v: number;
  amt: string;
  bld: string;
  memo?: string;
  tip?: string;
}

/**
 * Encrypt a NoteContent to the recipient's memo pubkey.
 */
export async function encryptNote(
  note: NoteContent,
  recipientPubkey: Point
): Promise<MemoCiphertext> {
  const wire: NoteWire = {
    v: NOTE_VERSION,
    amt: note.amount.toString(),
    bld: note.blinding.toString(),
  };
  if (note.memo !== undefined) wire.memo = note.memo;
  if (note.tipId !== undefined) wire.tip = note.tipId;
  return encryptText(JSON.stringify(wire), recipientPubkey);
}

/**
 * Decrypt a note blob using the recipient's memo privkey.
 * Throws on failure (corrupt ciphertext or unknown privkey).
 */
export async function decryptNote(
  ciphertext: Uint8Array,
  ephPubkey: Point,
  privkey: bigint
): Promise<NoteContent> {
  const plaintext = await decryptText(ciphertext, ephPubkey, privkey);
  let wire: unknown;
  try {
    wire = JSON.parse(plaintext);
  } catch {
    throw new Error("decryptNote: payload is not valid JSON");
  }
  const w = wire as NoteWire;
  if (
    typeof w !== "object" ||
    w === null ||
    w.v !== NOTE_VERSION ||
    typeof w.amt !== "string" ||
    typeof w.bld !== "string"
  ) {
    throw new Error(`decryptNote: invalid note format (v=${(w as NoteWire)?.v})`);
  }
  return {
    amount: BigInt(w.amt),
    blinding: BigInt(w.bld),
    memo: w.memo,
    tipId: w.tip,
  };
}
