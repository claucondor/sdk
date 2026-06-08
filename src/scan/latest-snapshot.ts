/**
 * scan/latest-snapshot.ts — Reconstruct current shielded state from on-chain events.
 *
 * Algorithm (v0.7.6 — reverse-scan early-exit):
 *   1. Scan EVM logs in reverse, chunk by chunk (newest blocks first).
 *   2. For each event involving the user (Wrap/Unwrap/ShieldedTransfer-from-user),
 *      try to decrypt the snapshot blob.
 *   3. EARLY EXIT on the first successfully-decrypted snapshot — that's the latest
 *      by chain order.
 *   4. Falls back to walking ~latest blocks - 50_000 before giving up.
 *
 * This replaces the v0.5 forward-scan-all approach (which took 8s+ for any wallet
 * with multi-day history); reverse + early-exit takes ~1s typical, ~5s worst-case.
 *
 * NOTE: ordering by chain block (not timestampMs) — block is authoritative,
 * timestampMs comes from Date.now() at snapshot-encrypt-time and can be off
 * if the client's clock is wrong.
 */

import { ethers } from "ethers";
import { decryptSnapshot } from "../crypto/snapshot-schema";
import type { SnapshotContent } from "../types";

const EVENTS_ABI = [
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event ShieldedTransferWithSnapshot(address indexed from, address indexed to, bytes encryptedSnapshotFrom, uint256 ephPubkeyFromX, uint256 ephPubkeyFromY, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
  "event UnwrapWithSnapshot(address indexed user, address indexed recipient, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
];

const CHUNK = 500;
const MAX_BLOCKS_BACK = 200_000; // ~3 days at 1s blocks; bail after this

export interface LatestSnapshotResult {
  snapshot: SnapshotContent;
  blockNumber: number;
}

/**
 * Reverse-scan + early-exit version. Returns the most recent decryptable
 * self-snapshot along with its on-chain block number — useful for callers
 * that need to chain with `scanIncomingNotes(fromBlock = blockNumber + 1)`.
 *
 * Returns null if no decryptable snapshot is found within MAX_BLOCKS_BACK.
 */
export async function getLatestSnapshotWithBlock(
  userEvmAddr: string,
  contractAddr: string,
  provider: ethers.Provider,
  memoPrivKey: bigint,
  opts?: { maxBlocksBack?: number }
): Promise<LatestSnapshotResult | null> {
  const iface = new ethers.Interface(EVENTS_ABI);
  const latest = await provider.getBlockNumber();
  const earliest = Math.max(0, latest - (opts?.maxBlocksBack ?? MAX_BLOCKS_BACK));
  const userLower = userEvmAddr.toLowerCase();

  let to = latest;
  while (to >= earliest) {
    const from = Math.max(earliest, to - CHUNK + 1);
    const logs = await provider.getLogs({ address: contractAddr, fromBlock: from, toBlock: to });
    // Process newest-first within the chunk
    logs.sort((a, b) => b.blockNumber - a.blockNumber);
    for (const log of logs) {
      let parsed;
      try { parsed = iface.parseLog({ topics: [...log.topics], data: log.data }); } catch { continue; }
      if (!parsed) continue;
      let ct: Uint8Array | null = null;
      let ephX = 0n, ephY = 0n;
      if (parsed.name === "WrapWithSnapshot" || parsed.name === "UnwrapWithSnapshot") {
        if ((parsed.args.user as string).toLowerCase() !== userLower) continue;
        ct = ethers.getBytes(parsed.args.encryptedSnapshot as string);
        ephX = BigInt(parsed.args.ephPubkeyX);
        ephY = BigInt(parsed.args.ephPubkeyY);
      } else if (parsed.name === "ShieldedTransferWithSnapshot") {
        if ((parsed.args.from as string).toLowerCase() !== userLower) continue;
        ct = ethers.getBytes(parsed.args.encryptedSnapshotFrom as string);
        ephX = BigInt(parsed.args.ephPubkeyFromX);
        ephY = BigInt(parsed.args.ephPubkeyFromY);
      }
      if (!ct) continue;
      const decoded = await decryptSnapshot(ct, { x: ephX, y: ephY }, memoPrivKey);
      if (decoded === null) continue;
      return { snapshot: decoded, blockNumber: log.blockNumber };
    }
    if (from === earliest) break;
    to = from - 1;
  }
  return null;
}

/**
 * Reconstruct the latest shielded state for a user.
 *
 * Returns the most recent decryptable snapshot, or null if none found within
 * the lookback window.
 *
 * Backward compatible: existing callers get the same SnapshotContent | null.
 * Uses reverse-scan + early-exit internally (~8x faster than v0.5 forward scan).
 */
export async function getLatestSnapshot(
  userEvmAddr: string,
  contractAddr: string,
  provider: ethers.Provider,
  memoPrivKey: bigint,
  opts?: { fromBlock?: bigint }
): Promise<SnapshotContent | null> {
  // The legacy `fromBlock` opt is kept for API compat but no longer used —
  // reverse scan walks back from latest naturally.
  void opts;
  const result = await getLatestSnapshotWithBlock(userEvmAddr, contractAddr, provider, memoPrivKey);
  return result?.snapshot ?? null;
}
