/**
 * scan/event-scanner.ts — Generic event scanner for snapshot + note events.
 *
 * Scans JanusToken EVM contracts for snapshot events (self-directed blobs)
 * and note events (sender-to-recipient blobs from shieldedTransfer).
 *
 * EVM event signatures (v0.6 contracts, SAME across JanusFlow/JanusWFLOW/JanusMockUSDC):
 *   WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)
 *   ShieldedTransferWithSnapshot(address indexed sender, address indexed recipient, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)
 *   UnwrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)
 *   MemoKeyPublished(address indexed user, uint256 pubkeyX, uint256 pubkeyY)
 *
 * Block range: Flow EVM testnet caps eth_getLogs at ~9000 blocks per request.
 */

import { ethers } from "ethers";
import type { DepositRecord } from "../types";

const CHUNK = 9000;

// ABI fragments for v0.6 events (snapshot + note fields in ShieldedTransfer)
const EVENTS_ABI = [
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
  "event ShieldedTransferWithSnapshot(address indexed sender, address indexed recipient, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)",
  "event UnwrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)",
];

const FIRST_SNAPSHOT_ABI = [
  "function firstSnapshotBlock(address) view returns (uint256)",
  "function memoKeyPubX(address) view returns (uint256)",
  "function memoKeyPubY(address) view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
  "function firstSnapshotBlock(address user) view returns (uint256)",
];

export interface RawSnapshotEvent {
  /** Encrypted self-directed snapshot ciphertext */
  ciphertext: Uint8Array;
  ephPubkey: { x: bigint; y: bigint };
  /** Unix timestamp in MILLISECONDS */
  timestampMs: number;
  txHash: string;
  blockNumber: number;
  eventType: "wrap" | "shieldedTransfer" | "unwrap";
}

export interface RawNoteEvent {
  /** Encrypted note-to-recipient ciphertext */
  ciphertext: Uint8Array;
  ephPubkey: { x: bigint; y: bigint };
  /** Unix timestamp in MILLISECONDS */
  timestampMs: number;
  txHash: string;
  blockNumber: number;
}

/**
 * Scan all `*WithSnapshot` events for a user (as sender/unwrapper).
 * Returns self-directed snapshot blobs, sorted by blockNumber ascending.
 */
export async function scanSnapshots(
  userEvmAddr: string,
  contractAddr: string,
  provider: ethers.Provider,
  opts?: { fromBlock?: bigint }
): Promise<RawSnapshotEvent[]> {
  const iface = new ethers.Interface(EVENTS_ABI);

  let fromBlock: number;
  if (opts?.fromBlock !== undefined) {
    fromBlock = Number(opts.fromBlock);
  } else {
    const hintContract = new ethers.Contract(contractAddr, FIRST_SNAPSHOT_ABI, provider);
    const firstBig: bigint = await hintContract.firstSnapshotBlock(userEvmAddr);
    if (firstBig === 0n) return [];
    fromBlock = Number(firstBig);
  }

  const latestBlock = await provider.getBlockNumber();
  const userTopic = ethers.zeroPadValue(userEvmAddr.toLowerCase(), 32);

  const seen = new Set<string>();
  const allLogs: ethers.Log[] = [];

  for (let start = fromBlock; start <= latestBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latestBlock);
    const [wrapLogs, xfrLogs, unwrapLogs] = await Promise.all([
      provider.getLogs({
        address: contractAddr,
        fromBlock: start,
        toBlock: end,
        topics: [iface.getEvent("WrapWithSnapshot")!.topicHash, userTopic],
      }),
      provider.getLogs({
        address: contractAddr,
        fromBlock: start,
        toBlock: end,
        // sender is topics[1] — we want sender's snapshot
        topics: [iface.getEvent("ShieldedTransferWithSnapshot")!.topicHash, userTopic],
      }),
      provider.getLogs({
        address: contractAddr,
        fromBlock: start,
        toBlock: end,
        topics: [iface.getEvent("UnwrapWithSnapshot")!.topicHash, userTopic],
      }),
    ]);
    for (const log of [...wrapLogs, ...xfrLogs, ...unwrapLogs]) {
      const key = `${log.blockNumber}-${log.transactionIndex}-${log.index}`;
      if (!seen.has(key)) {
        seen.add(key);
        allLogs.push(log);
      }
    }
  }

  allLogs.sort((a, b) => a.blockNumber - b.blockNumber);

  const uniqueBlocks = [...new Set(allLogs.map((l) => l.blockNumber))];
  const blockTsMap = new Map<number, number>();
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      const block = await provider.getBlock(bn);
      if (block) blockTsMap.set(bn, block.timestamp * 1000); // convert seconds → ms
    })
  );

  const results: RawSnapshotEvent[] = [];
  for (const log of allLogs) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      const ciphertext = ethers.getBytes(parsed.args.encryptedSnapshot as string);
      const timestampMs = blockTsMap.get(log.blockNumber) ?? log.blockNumber * 1000;
      const eventType =
        parsed.name === "WrapWithSnapshot"
          ? "wrap"
          : parsed.name === "UnwrapWithSnapshot"
          ? "unwrap"
          : "shieldedTransfer";
      results.push({
        ciphertext,
        ephPubkey: {
          x: BigInt(parsed.args.ephPubkeyX),
          y: BigInt(parsed.args.ephPubkeyY),
        },
        timestampMs,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        eventType,
      });
    } catch {
      // skip undecodable logs
    }
  }
  return results;
}

/**
 * Scan ShieldedTransferWithSnapshot events where the user is the RECIPIENT.
 * Returns note-to-recipient blobs (encryptedNoteTo), sorted ascending.
 */
export async function scanIncomingNotes(
  recipientEvmAddr: string,
  contractAddr: string,
  provider: ethers.Provider,
  opts?: { fromBlock?: bigint }
): Promise<(RawNoteEvent & DepositRecord)[]> {
  const iface = new ethers.Interface(EVENTS_ABI);

  let fromBlock: number;
  if (opts?.fromBlock !== undefined) {
    fromBlock = Number(opts.fromBlock);
  } else {
    const hintContract = new ethers.Contract(contractAddr, FIRST_SNAPSHOT_ABI, provider);
    const firstBig: bigint = await hintContract.firstSnapshotBlock(recipientEvmAddr);
    // Recipient might have no own snapshots but still receive notes — fallback scan 10k blocks
    fromBlock = firstBig === 0n ? Math.max(0, (await provider.getBlockNumber()) - 10000) : Number(firstBig);
  }

  const latestBlock = await provider.getBlockNumber();
  const recipientTopic = ethers.zeroPadValue(recipientEvmAddr.toLowerCase(), 32);

  const seen = new Set<string>();
  const allLogs: ethers.Log[] = [];

  for (let start = fromBlock; start <= latestBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latestBlock);
    const logs = await provider.getLogs({
      address: contractAddr,
      fromBlock: start,
      toBlock: end,
      // recipient is topics[2]
      topics: [iface.getEvent("ShieldedTransferWithSnapshot")!.topicHash, null, recipientTopic],
    });
    for (const log of logs) {
      const key = `${log.blockNumber}-${log.transactionIndex}-${log.index}`;
      if (!seen.has(key)) {
        seen.add(key);
        allLogs.push(log);
      }
    }
  }

  allLogs.sort((a, b) => a.blockNumber - b.blockNumber);

  const uniqueBlocks = [...new Set(allLogs.map((l) => l.blockNumber))];
  const blockTsMap = new Map<number, number>();
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      const block = await provider.getBlock(bn);
      if (block) blockTsMap.set(bn, block.timestamp * 1000);
    })
  );

  const results: (RawNoteEvent & DepositRecord)[] = [];
  for (const log of allLogs) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      const ciphertext = ethers.getBytes(parsed.args.encryptedNoteTo as string);
      const timestampMs = blockTsMap.get(log.blockNumber) ?? log.blockNumber * 1000;
      results.push({
        ciphertext,
        ephPubkey: {
          x: BigInt(parsed.args.ephPubkeyToX),
          y: BigInt(parsed.args.ephPubkeyToY),
        },
        timestampMs,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      });
    } catch {
      // skip
    }
  }
  return results;
}
