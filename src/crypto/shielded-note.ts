/**
 * crypto/shielded-note.ts — Protocol-level note attached to every JanusFlow
 * shielded transfer.
 *
 * THE GAP THIS SOLVES
 * -------------------
 * A shielded transfer hands the recipient a fresh Pedersen commitment
 * delta `C_tx = amount*G + transferBlinding*H`, but the recipient only
 * sees the elliptic-curve point. To later unwrap (or re-transfer), the
 * recipient MUST know `amount` and `transferBlinding` in cleartext —
 * those values feed the Groth16 witness. The sender knows both. The
 * recipient does not, unless the sender ships them over an end-to-end
 * encrypted channel.
 *
 * JanusFlow ships exactly that channel via ECIES + BabyJub (the same
 * primitive used for memo encryption), but transport alone isn't enough:
 * apps also need a CONVENTION about which fields the payload must contain
 * so recipients can decrypt it the same way regardless of which app sent
 * the transfer. That's what `ShieldedNote` is: the canonical payload
 * every JanusFlow shielded transfer SHOULD attach.
 *
 * `amount` and `blinding` are protocol-level (required for correctness);
 * `data` is an app-level UTF-8 stowaway (memo text, NFT metadata, sealed
 * bid amount, etc. — apps pick the schema).
 *
 * SERIALIZATION
 * -------------
 * JSON, encrypted as a single UTF-8 string via existing `encryptText`. We
 * encode bigints as decimal strings (a/b fields) — keeps the wire format
 * inspectable and avoids reinventing CBOR/protobuf for ~100-byte payloads.
 *
 *   {"v":1,"a":"<amount>","b":"<blinding>","d":"<optional data>"}
 *
 * Versioned via `v` so future SDK revisions can extend the schema without
 * breaking decoders.
 */

import type { Point } from "../types/commitment";
import { encryptText, type MemoCiphertext } from "./encrypt-text";
import { decryptText } from "./decrypt-text";

const NOTE_VERSION = 1;

/**
 * Canonical payload that accompanies a JanusFlow shielded transfer.
 *
 * - `amount`   wei amount being transferred (recipient needs this to
 *              learn their new shielded balance).
 * - `blinding` the per-transfer blinding factor the sender used to build
 *              C_tx. Recipient adds it to their accumulated blinding so
 *              the local (balance, blinding) pair stays consistent with
 *              the on-chain commitment.
 * - `data`     optional UTF-8 app-specific payload. PrivateTip stuffs the
 *              memo text here; SealedBidNFT would stuff the bid amount;
 *              HiddenPackOpening would stuff the pack contents seed; etc.
 */
export interface ShieldedNote {
  amount: bigint;
  blinding: bigint;
  data?: string;
}

interface NoteWire {
  v: number;
  a: string;
  b: string;
  d?: string;
}

/**
 * Encrypt a `ShieldedNote` to the recipient's BabyJub pubkey. Output is
 * the same {ciphertext, ephemeralPubkey} frame as `encryptText` — drop it
 * into your shielded transfer transaction.
 */
export async function encryptShieldedNote(
  note: ShieldedNote,
  recipientPubkey: Point
): Promise<MemoCiphertext> {
  const wire: NoteWire = {
    v: NOTE_VERSION,
    a: note.amount.toString(),
    b: note.blinding.toString(),
  };
  if (note.data !== undefined) {
    wire.d = note.data;
  }
  const json = JSON.stringify(wire);
  return encryptText(json, recipientPubkey);
}

/**
 * Decrypt a `ShieldedNote` from its ECIES envelope.
 *
 * Throws if the ciphertext doesn't decode to a versioned note (likely
 * means it's a legacy plain-text memo, or a payload from a different
 * protocol). Callers handling mixed legacy + note ciphertexts should
 * try this first and fall back to `decryptText` on parse failure.
 */
export async function decryptShieldedNote(
  ciphertext: Uint8Array,
  ephemeralPubkey: Point,
  privkey: bigint
): Promise<ShieldedNote> {
  const plaintext = await decryptText(ciphertext, ephemeralPubkey, privkey);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error(
      "decryptShieldedNote: payload is not JSON (likely a legacy plain-text memo)"
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as NoteWire).v !== "number" ||
    typeof (parsed as NoteWire).a !== "string" ||
    typeof (parsed as NoteWire).b !== "string"
  ) {
    throw new Error("decryptShieldedNote: missing required note fields {v,a,b}");
  }
  const wire = parsed as NoteWire;
  if (wire.v !== NOTE_VERSION) {
    throw new Error(
      `decryptShieldedNote: unsupported note version ${wire.v} (this SDK speaks ${NOTE_VERSION})`
    );
  }
  return {
    amount: BigInt(wire.a),
    blinding: BigInt(wire.b),
    data: wire.d,
  };
}
