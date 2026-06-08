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
 *   v2: {"v":2,"bal":"<decimal>","bld":"<decimal>","tms":<number>}
 *   v3: {"v":3,"bal":"<decimal>","bld":"<decimal>","tms":<number>,"txAmt":"<decimal>","rcp":"<string>","memo":"<string>"}
 *        (txAmt/rcp/memo are optional — only present on shielded-transfer sender snapshots)
 *
 * Backward compat: v2 snapshots still decrypt (version check accepts 2 or 3).
 */

import { encryptText, type MemoCiphertext } from "./encrypt-text";
import { decryptText } from "./decrypt-text";
import type { SnapshotContent } from "../types";
import type { Point } from "../types/commitment";

export { SNAPSHOT_TIMESTAMP_UNIT } from "../types";

const SCHEMA_VERSION = 3;

interface SnapshotWire {
  v: number;
  bal: string;
  bld: string;
  tms: number;
  // v3 additions, all optional
  txAmt?: string;  // transfer amount (only for shielded-transfer snapshots)
  rcp?: string;    // recipient hint (Cadence address or COA EVM hex)
  memo?: string;   // memo plaintext
}

/**
 * Encrypt a SnapshotContent to a pubkey (typically the user's own memokey).
 * If snapshot includes txAmt/rcp/memo they are written into the v3 wire format.
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
  if (snapshot.txAmt !== undefined) wire.txAmt = snapshot.txAmt.toString();
  if (snapshot.rcp !== undefined) wire.rcp = snapshot.rcp;
  if (snapshot.memo !== undefined) wire.memo = snapshot.memo;
  return encryptText(JSON.stringify(wire), recipientPubkey);
}

/**
 * Decrypt a snapshot blob using the holder's memo privkey.
 * Returns null on failure (wrong key, corrupt ciphertext, unsupported version) —
 * silent null allows bulk scanning without crashing on unrelated events.
 *
 * Backward compat: accepts v=2 (legacy) and v=3 (current).
 * v2 snapshots return txAmt/rcp/memo as undefined.
 */
export async function decryptSnapshot(
  ciphertext: Uint8Array,
  ephPubkey: Point,
  privkey: bigint
): Promise<SnapshotContent | null> {
  try {
    const plaintext = await decryptText(ciphertext, ephPubkey, privkey);
    const wire = JSON.parse(plaintext) as SnapshotWire;
    if (wire.v !== 2 && wire.v !== 3) return null;
    if (
      typeof wire.bal !== "string" ||
      typeof wire.bld !== "string" ||
      typeof wire.tms !== "number"
    ) {
      return null;
    }
    const result: SnapshotContent = {
      balance: BigInt(wire.bal),
      blinding: BigInt(wire.bld),
      timestampMs: wire.tms,
    };
    // v3 optional fields — only set if present in wire
    if (wire.txAmt !== undefined) result.txAmt = BigInt(wire.txAmt);
    if (wire.rcp !== undefined) result.rcp = wire.rcp;
    if (wire.memo !== undefined) result.memo = wire.memo;
    return result;
  } catch {
    return null;
  }
}
