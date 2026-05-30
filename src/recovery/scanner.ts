/**
 * recovery/scanner.ts — Scan JanusFlow EVM events for snapshot blobs.
 *
 * JanusFlow.sol v0.5.3 emits snapshot events on every state-changing op:
 *   WrapWithSnapshot(user, amount, encryptedSnapshot, ephPubkeyX, ephPubkeyY)
 *   ShieldedTransferWithSnapshot(sender, recipient, encryptedSnapshot, ephPubkeyX, ephPubkeyY)
 *   UnwrapWithSnapshot(user, amount, encryptedSnapshot, ephPubkeyX, ephPubkeyY)
 *
 * v0.5.3+: The contract also exposes `firstSnapshotBlock(address)` — a public
 * mapping that stores the block number of each user's FIRST snapshot event.
 * The scanner reads this in one eth_call (O(1)) and paginates from there
 * instead of relying on a fixed default window.
 *
 * This scanner fetches all three event types for a given user address and
 * returns the raw encrypted blobs sorted by block number. The caller then
 * tries decryptSnapshot() on each blob and feeds successful decryptions into
 * reconstructFromSnapshots().
 */

import { ethers } from "ethers";

export const JANUS_FLOW_DEFAULT = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";

// ---------------------------------------------------------------------------
// Event ABI fragments (JanusFlow v0.5.2+)
// ---------------------------------------------------------------------------

const EVENTS_ABI = [
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event ShieldedTransferWithSnapshot(address indexed sender, address indexed recipient, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event UnwrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
];

// ABI fragment for the v0.5.3 firstSnapshotBlock hint mapping.
const FIRST_SNAPSHOT_ABI = [
  "function firstSnapshotBlock(address) view returns (uint256)",
];

/** Flow EVM testnet eth_getLogs block-range cap. */
const CHUNK = 9000;

export interface RawSnapshot {
  ciphertext: Uint8Array;
  ephPubkey: { x: bigint; y: bigint };
  /** Unix timestamp in seconds — estimated from block number (not exact). */
  timestamp: number;
  txHash: string;
  blockNumber: number;
}

/**
 * Scan JanusFlow for all `*WithSnapshot` events where `userEvmAddr` is the
 * indexed `user` (or `sender`) field. Also includes events where the user is
 * the `recipient` in ShieldedTransferWithSnapshot so incoming credits are
 * captured.
 *
 * **v0.5.4 behaviour (default — no `fromBlock` override):**
 * 1. Calls `contract.firstSnapshotBlock(userEvmAddr)` — one eth_call, O(1).
 * 2. If the mapping returns 0 the user has never interacted; returns `[]`
 *    immediately without fetching any logs.
 * 3. If the mapping returns a non-zero block number, paginate from that block
 *    to `latest` in 9000-block chunks (Flow EVM testnet cap).
 *
 * **Explicit `fromBlock` override:**
 * Pass `opts.fromBlock` to bypass the on-chain hint entirely (e.g. for
 * cross-chain ports that don't have the mapping, or integration tests).
 * When provided, `getBlockNumber` is called once to bound the range and the
 * hint contract call is skipped.
 *
 * @param userEvmAddr    EVM address to scan for (checksummed or lowercase)
 * @param provider       ethers v6 Provider connected to Flow EVM testnet
 * @param opts.fromBlock Override starting block (skips firstSnapshotBlock hint)
 * @param opts.janusFlowAddr Override JanusFlow proxy address (for testing)
 */
export async function scanJanusFlowSnapshots(
  userEvmAddr: string,
  provider: ethers.Provider,
  opts?: { fromBlock?: number; janusFlowAddr?: string }
): Promise<RawSnapshot[]> {
  const addr = opts?.janusFlowAddr ?? JANUS_FLOW_DEFAULT;

  // ─── 1. Determine fromBlock ──────────────────────────────────────────────
  let fromBlock: number;

  if (opts?.fromBlock !== undefined) {
    // Explicit override — use it directly.
    fromBlock = opts.fromBlock;
  } else {
    // Read the on-chain hint: firstSnapshotBlock[user] stores the block
    // number of the user's first wrap/transfer/unwrap (set by JanusFlow
    // v0.5.3+). One eth_call, zero log scanning.
    const hintContract = new ethers.Contract(addr, FIRST_SNAPSHOT_ABI, provider);
    const firstBlockBig: bigint = await hintContract.firstSnapshotBlock(userEvmAddr);
    const firstBlock = Number(firstBlockBig);

    if (firstBlock === 0) {
      // User has never interacted with JanusFlow — nothing to scan.
      return [];
    }

    fromBlock = firstBlock;
  }

  // ─── 2. Paginate from fromBlock → latest in CHUNK-block windows ──────────
  const latestBlock = await provider.getBlockNumber();
  const iface = new ethers.Interface(EVENTS_ABI);
  const userTopic = ethers.zeroPadValue(userEvmAddr.toLowerCase(), 32);

  const seen = new Set<string>();
  const allLogs: ethers.Log[] = [];

  for (let start = fromBlock; start <= latestBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latestBlock);

    // Parallel fetch all 4 event topic combinations for this chunk.
    const [wrapLogs, xfrSenderLogs, xfrRecipientLogs, unwrapLogs] = await Promise.all([
      provider.getLogs({
        address: addr,
        fromBlock: start,
        toBlock: end,
        topics: [iface.getEvent("WrapWithSnapshot")!.topicHash, userTopic],
      }),
      provider.getLogs({
        address: addr,
        fromBlock: start,
        toBlock: end,
        // sender is topics[1]
        topics: [iface.getEvent("ShieldedTransferWithSnapshot")!.topicHash, userTopic],
      }),
      provider.getLogs({
        address: addr,
        fromBlock: start,
        toBlock: end,
        // recipient is topics[2]
        topics: [iface.getEvent("ShieldedTransferWithSnapshot")!.topicHash, null, userTopic],
      }),
      provider.getLogs({
        address: addr,
        fromBlock: start,
        toBlock: end,
        topics: [iface.getEvent("UnwrapWithSnapshot")!.topicHash, userTopic],
      }),
    ]);

    // Deduplicate (sender == recipient possible in self-transfers)
    for (const log of [...wrapLogs, ...xfrSenderLogs, ...xfrRecipientLogs, ...unwrapLogs]) {
      const key = `${log.blockNumber}-${log.transactionIndex}-${log.index}`;
      if (!seen.has(key)) {
        seen.add(key);
        allLogs.push(log);
      }
    }
  }

  // ─── 3. Sort by block number ascending ───────────────────────────────────
  allLogs.sort((a, b) => a.blockNumber - b.blockNumber);

  // ─── 4. Decode each log into a RawSnapshot ───────────────────────────────
  const results: RawSnapshot[] = [];
  for (const log of allLogs) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;

      const encBytes: string = parsed.args.encryptedSnapshot as string;
      const ephX: bigint = BigInt(parsed.args.ephPubkeyX);
      const ephY: bigint = BigInt(parsed.args.ephPubkeyY);

      const ciphertext = ethers.getBytes(encBytes);

      results.push({
        ciphertext,
        ephPubkey: { x: ephX, y: ephY },
        // Use block number as a proxy timestamp (actual block timestamp
        // requires an extra RPC call per block — expensive at scale).
        timestamp: log.blockNumber,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      });
    } catch {
      // Skip logs that can't be decoded (shouldn't happen with our ABI, but
      // be defensive in case of ABI drift or corrupt data).
    }
  }

  return results;
}
