/**
 * crypto/snapshot-schema.ts — Snapshot encode/decode (self-directed ECIES blob).
 *
 * A snapshot is a self-directed encrypted blob that captures the user's
 * current (balance, blinding) pair. It is emitted on every wrap/shieldedTransfer/
 * unwrap so the user can recover their state purely from on-chain events.
 *
 * TIMESTAMP UNIT: always milliseconds since Unix epoch.
 * Export the constant so every layer that reads/writes timestamps references
 * a single authoritative source — the v0.5.6 bug was a unit mismatch.
 *
 * Wire format (JSON inside ECIES envelope):
 *   {"v":2,"bal":"<decimal>","bld":"<decimal>","tms":<number>}
 *
 * v=2 to distinguish from v0.5 ShieldedNote wire format (v=1 used "a"/"b").
 */

import { encryptText, type MemoCiphertext } from "./encrypt-text";
import { decryptText } from "./decrypt-text";
import type { SnapshotContent } from "../types";
import type { Point } from "../types/commitment";

export { SNAPSHOT_TIMESTAMP_UNIT } from "../types";

const SCHEMA_VERSION = 2;

interface SnapshotWire {
  v: number;
  bal: string;
  bld: string;
  tms: number;
}

/**
 * Encrypt a SnapshotContent to a pubkey (typically the user's own memokey).
 */
export async function encryptSnapshot(
  snapshot: SnapshotContent,
  recipientPubkey: Point
): Promise<MemoCiphertext> {
  const wire: SnapshotWire = {
    v: SCHEMA_VERSION,
    bal: snapshot.balance.toString(),
    bld: snapshot.blinding.toString(),
    tms: snapshot.timestampMs,
  };
  return encryptText(JSON.stringify(wire), recipientPubkey);
}

/**
 * Decrypt a snapshot blob using the holder's memo privkey.
 * Returns null on failure (wrong key, corrupt ciphertext, version mismatch) —
 * silent null allows bulk scanning without crashing on unrelated events.
 */
export async function decryptSnapshot(
  ciphertext: Uint8Array,
  ephPubkey: Point,
  privkey: bigint
): Promise<SnapshotContent | null> {
  try {
    const plaintext = await decryptText(ciphertext, ephPubkey, privkey);
    const wire = JSON.parse(plaintext) as SnapshotWire;
    if (wire.v !== SCHEMA_VERSION) return null;
    if (
      typeof wire.bal !== "string" ||
      typeof wire.bld !== "string" ||
      typeof wire.tms !== "number"
    ) {
      return null;
    }
    return {
      balance: BigInt(wire.bal),
      blinding: BigInt(wire.bld),
      timestampMs: wire.tms,
    };
  } catch {
    return null;
  }
}
