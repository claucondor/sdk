/**
 * recovery/snapshot.ts — Encryption helpers for shielded-state snapshots.
 *
 * Wraps existing ShieldedNote ECIES primitives (src/crypto/shielded-note.ts)
 * to produce self-directed snapshot blobs. These blobs are emitted by
 * JanusFlow.sol v0.5.2 on every wrap/shieldedTransfer/unwrap call so the
 * user can recover their (balance, blinding) pair from on-chain events alone.
 */

import { encryptShieldedNote, decryptShieldedNote } from "../crypto/shielded-note";
import type { MemoCiphertext } from "../crypto/encrypt-text";

export type { MemoCiphertext };

/**
 * Encrypt a snapshot of the user's shielded state to their own pubkey.
 * The resulting ciphertext + ephemeral pubkey are passed as calldata to
 * JanusFlow.sol which emits them verbatim in the `*WithSnapshot` events.
 */
export async function encryptSnapshotToSelf(
  snapshot: { balance: bigint; blinding: bigint },
  myPubkey: { x: bigint; y: bigint }
): Promise<{ ciphertext: Uint8Array; ephPubkey: { x: bigint; y: bigint } }> {
  const note = await encryptShieldedNote(
    { amount: snapshot.balance, blinding: snapshot.blinding },
    myPubkey
  );
  return {
    ciphertext: note.ciphertext,
    ephPubkey: note.ephemeralPubkey,
  };
}

/**
 * Decrypt a snapshot blob emitted in a `*WithSnapshot` event.
 *
 * Returns `null` if decryption fails (wrong privkey, corrupt ciphertext, or
 * an event intended for a different recipient — all are silent failures to
 * allow bulk scanning without crashing on unrelated events).
 */
export async function decryptSnapshot(
  ciphertext: Uint8Array,
  ephPubkey: { x: bigint; y: bigint },
  privkey: bigint
): Promise<{ balance: bigint; blinding: bigint } | null> {
  try {
    const decoded = await decryptShieldedNote(ciphertext, ephPubkey, privkey);
    return { balance: decoded.amount, blinding: decoded.blinding };
  } catch {
    return null;
  }
}
