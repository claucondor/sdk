/**
 * scan/latest-snapshot.ts — Reconstruct current shielded state from on-chain events.
 *
 * Algorithm:
 *   1. Scan all `*WithSnapshot` events for the user's address.
 *   2. Decrypt each blob with the user's memo privkey.
 *   3. Sort by timestampMs descending.
 *   4. Return the snapshot with the highest timestampMs (= current state).
 *
 * This replaces the v0.5 reconstruct.ts approach which incorrectly used
 * Unix seconds for timestamp comparisons (the v0.5.6/5.7 ordering bug).
 * All timestamps here are ALWAYS milliseconds.
 */

import { scanSnapshots } from "./event-scanner";
import { decryptSnapshot } from "../crypto/snapshot-schema";
import type { SnapshotContent } from "../types";
import type { ethers } from "ethers";

/**
 * Reconstruct the latest shielded state for a user by scanning on-chain
 * snapshot events and decrypting them.
 *
 * Returns the most recent successfully-decrypted snapshot, or null if no
 * valid snapshot is found (user has never wrapped, or wrong privkey).
 */
export async function getLatestSnapshot(
  userEvmAddr: string,
  contractAddr: string,
  provider: ethers.Provider,
  memoPrivKey: bigint,
  opts?: { fromBlock?: bigint }
): Promise<SnapshotContent | null> {
  const events = await scanSnapshots(userEvmAddr, contractAddr, provider, opts);
  if (events.length === 0) return null;

  // Try to decrypt all, keep successful ones, pick highest timestampMs
  const snapshots: SnapshotContent[] = [];
  for (const ev of events) {
    const decoded = await decryptSnapshot(ev.ciphertext, ev.ephPubkey, memoPrivKey);
    if (decoded !== null) snapshots.push(decoded);
  }

  if (snapshots.length === 0) return null;

  // Sort descending by timestampMs, return highest
  snapshots.sort((a, b) => b.timestampMs - a.timestampMs);
  return snapshots[0]!;
}
