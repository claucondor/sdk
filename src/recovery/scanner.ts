/**
 * recovery/scanner.ts — Scan JanusFlow EVM events for snapshot blobs.
 *
 * JanusFlow.sol v0.5.2 emits snapshot events on every state-changing op:
 *   WrapWithSnapshot(user, amount, encryptedSnapshot, ephPubkeyX, ephPubkeyY)
 *   ShieldedTransferWithSnapshot(sender, recipient, encryptedSnapshot, ephPubkeyX, ephPubkeyY)
 *   UnwrapWithSnapshot(user, amount, encryptedSnapshot, ephPubkeyX, ephPubkeyY)
 *
 * This scanner fetches all three event types for a given user address and
 * returns the raw encrypted blobs sorted by block number. The caller then
 * tries decryptSnapshot() on each blob and feeds successful decryptions into
 * reconstructFromSnapshots().
 */

import { ethers } from "ethers";

export const JANUS_FLOW_DEFAULT = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";

// ---------------------------------------------------------------------------
// Event ABI fragments (JanusFlow v0.5.2)
// ---------------------------------------------------------------------------

const EVENTS_ABI = [
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event ShieldedTransferWithSnapshot(address indexed sender, address indexed recipient, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event UnwrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
];

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
 * the `recipient` in ShieldedTransferWithSnapshot so senders-to-self (e.g.
 * snapshot-only transfers) are captured.
 *
 * @param userEvmAddr    EVM address to scan for (checksummed or lowercase)
 * @param provider       ethers v6 Provider connected to Flow EVM testnet
 * @param opts.fromBlock Start block (default: 0)
 * @param opts.janusFlowAddr Override JanusFlow proxy address (for testing)
 */
export async function scanJanusFlowSnapshots(
  userEvmAddr: string,
  provider: ethers.Provider,
  opts?: { fromBlock?: number; janusFlowAddr?: string }
): Promise<RawSnapshot[]> {
  const addr = opts?.janusFlowAddr ?? JANUS_FLOW_DEFAULT;
  const fromBlock = opts?.fromBlock ?? 0;

  const iface = new ethers.Interface(EVENTS_ABI);

  const userTopic = ethers.zeroPadValue(userEvmAddr.toLowerCase(), 32);

  // Fetch logs for all three event types in parallel.
  // For ShieldedTransferWithSnapshot we query BOTH sender and recipient slots.
  const [wrapLogs, xfrSenderLogs, xfrRecipientLogs, unwrapLogs] = await Promise.all([
    provider.getLogs({
      address: addr,
      topics: [iface.getEvent("WrapWithSnapshot")!.topicHash, userTopic],
      fromBlock,
      toBlock: "latest",
    }),
    provider.getLogs({
      address: addr,
      // sender is topics[1]
      topics: [iface.getEvent("ShieldedTransferWithSnapshot")!.topicHash, userTopic],
      fromBlock,
      toBlock: "latest",
    }),
    provider.getLogs({
      address: addr,
      // recipient is topics[2]
      topics: [iface.getEvent("ShieldedTransferWithSnapshot")!.topicHash, null, userTopic],
      fromBlock,
      toBlock: "latest",
    }),
    provider.getLogs({
      address: addr,
      topics: [iface.getEvent("UnwrapWithSnapshot")!.topicHash, userTopic],
      fromBlock,
      toBlock: "latest",
    }),
  ]);

  // Deduplicate (sender == recipient is possible in self-transfers)
  const seen = new Set<string>();
  const allLogs: ethers.Log[] = [];
  for (const log of [...wrapLogs, ...xfrSenderLogs, ...xfrRecipientLogs, ...unwrapLogs]) {
    const key = `${log.blockNumber}-${log.transactionIndex}-${log.index}`;
    if (!seen.has(key)) {
      seen.add(key);
      allLogs.push(log);
    }
  }

  // Sort by block number ascending
  allLogs.sort((a, b) => a.blockNumber - b.blockNumber);

  // Decode each log into a RawSnapshot
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
