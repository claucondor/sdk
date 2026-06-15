/**
 * crypto/checkpoint-schema.ts — Checkpoint encode/decode (self-directed ECIES blob).
 *
 * A checkpoint is a self-directed encrypted blob that captures the sender's
 * current (balance, blinding) pair after a transfer. It is stored in
 * ShieldedCheckpoint.update() so the sender can recover their state without
 * scanning all historical events.
 *
 * Wire format (JSON inside ECIES envelope):
 *   v1: {"v":1,"bal":"<decimal>","bld":"<decimal>"}
 *
 * Design: minimal and schema-agnostic. ShieldedCheckpoint stores opaque bytes.
 * The SDK defines this canonical schema; apps may extend it locally by building
 * their own encrypted payload on top of encryptText/decryptText primitives.
 *
 * Backward compat: v2/v3 snapshots from the v0.7 event-scanner era are accepted
 * on decrypt to ease any migration, but v1 is written on all new updates.
 */

import { encryptText, type MemoCiphertext } from "./encrypt-text";
import { decryptText } from "./decrypt-text";
import type { SnapshotContent } from "../types";
import type { Point } from "../types/commitment";

export type { MemoCiphertext };

const SCHEMA_VERSION = 1;

interface CheckpointWire {
  v: number;
  bal: string;
  bld: string;
}

/**
 * Encrypt a SnapshotContent into an ECIES blob for ShieldedCheckpoint.update().
 * Typically encrypted to the sender's own memo pubkey.
 */
export async function encryptSnapshot(
  snapshot: SnapshotContent,
  recipientPubkey: Point
): Promise<MemoCiphertext> {
  const wire: CheckpointWire = {
    v: SCHEMA_VERSION,
    bal: snapshot.balance.toString(),
    bld: snapshot.blinding.toString(),
  };
  return encryptText(JSON.stringify(wire), recipientPubkey);
}

/**
 * Decrypt a checkpoint blob using the holder's memo privkey.
 * Returns null on failure (wrong key, corrupt ciphertext, unsupported version) —
 * silent null allows ShieldedCheckpoint.read() failures to surface cleanly.
 *
 * Backward compat: accepts v=1 (current), v=2 (legacy), v=3 (scan-era legacy).
 */
export async function decryptSnapshot(
  ciphertext: Uint8Array,
  ephPubkey: Point,
  privkey: bigint
): Promise<SnapshotContent | null> {
  try {
    const plaintext = await decryptText(ciphertext, ephPubkey, privkey);
    const wire = JSON.parse(plaintext) as CheckpointWire;
    // Accept v1 (new), v2 and v3 (legacy scan-era)
    if (wire.v !== 1 && wire.v !== 2 && wire.v !== 3) return null;
    if (typeof wire.bal !== "string" || typeof wire.bld !== "string") return null;
    return {
      balance: BigInt(wire.bal),
      blinding: BigInt(wire.bld),
    };
  } catch {
    return null;
  }
}
