/**
 * scan/cadence-scanner.ts — Cadence event scanner for JanusFT.
 *
 * Uses Flow REST API to query Cadence events. Flow testnet caps event range
 * at 250 blocks per request, so this paginates aggressively.
 *
 * Actual event field names emitted by JanusFT v0.6 (same schema as JanusMockFT v0.6,
 * deployed contract at 0x7599043aea001283):
 *
 *   - WrapWithSnapshot(account: Address, commitX, commitY,
 *       encryptedSnapshot, ephPubX, ephPubY)
 *   - ShieldedTransferWithSnapshot(
 *       fromCommitX/Y, toCommitX/Y,
 *       encryptedSnapshotFrom, ephPubFromX, ephPubFromY,
 *       encryptedNoteTo, ephPubToX, ephPubToY
 *     )
 *     NOTE: NO sender/recipient ADDRESSES in this event — privacy-by-design.
 *     The scanner returns ALL transfer events in the time window; the caller
 *     decrypts every blob and successful decryption identifies the intended
 *     recipient (only the holder of the matching memo privkey can decrypt).
 *   - UnwrapWithSnapshot(account: Address, recipient: Address, amount,
 *       encryptedSnapshot, ephPubX, ephPubY)
 *
 * Event payload encoding: Flow returns events as base64-encoded JSON-CDC.
 * We decode then walk the JSON to extract the encrypted blob + ephemeral pubkey.
 */

import type { DepositRecord } from "../types";
import { FLOW_CADENCE_ACCESS, PROTOCOL_GENESIS_BLOCK, FIRST_SNAPSHOT_LIVE_BLOCK } from "../network/contracts";

const FLOW_EVENT_RANGE_MAX = 250; // testnet cap per /v1/events request
// Default lookback when no fromBlock is provided. Flow testnet caps event
// queries at 250 blocks per request, so a 250k window = ~1000 sequential
// REST calls (slow). Callers SHOULD pass an explicit fromBlock from
// app state (e.g. last-scanned block).
// HOT FIX 2026-06-08: reduced from 100_000 to 5_000 — at ~2.6s per request,
// 100k / 250 = 400 requests = 17 min per scan. 5k covers ~30 min of recent
// testnet history, sufficient for wraps within the last half hour. Users with
// older wraps should pass explicit fromBlock or rely on findFirstSnapshotBlock.
//
// 100_000 blocks ≈ 28 hours at ~1 block/s on Flow testnet — wide enough to
// cover any same-day wrap/transfer while keeping REST calls to ~400 per event
// type (~3 types × 400 = ~1200 total, typically <60s).
//
// HISTORY: was 5_000 (≈83 min). Bumped to 100_000 on 2026-06-05 after operator
// reported "no recoverable state" for a wrap done ~2.8h earlier (10k blocks out
// of the old window). Root cause: DEFAULT_LOOKBACK too small.
const DEFAULT_LOOKBACK = 5_000;

interface JsonCDCValue {
  type: string;
  value: unknown;
}

interface CadenceEventResultRow {
  block_height: string;
  block_timestamp: string; // ISO 8601
  block_id: string;
  events?: Array<{
    type: string;
    transaction_id: string;
    transaction_index: string;
    event_index: string;
    payload: string; // base64-encoded JSON-CDC composite
  }>;
}

export interface CadenceSnapshotEvent {
  ciphertext: Uint8Array;
  ephPubkey: { x: bigint; y: bigint };
  timestampMs: number;
  txHash: string;
  blockHeight: number;
  eventType: "wrap" | "shieldedTransfer" | "unwrap";
}

export interface CadenceNoteEvent extends DepositRecord {
  blockHeight: number;
}

// ---------------------------------------------------------------------------
// JSON-CDC helpers (decode base64-JSON → extract fields)
// ---------------------------------------------------------------------------

function b64DecodeToString(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

function eventFieldsByName(payload: JsonCDCValue): Record<string, JsonCDCValue> {
  const out: Record<string, JsonCDCValue> = {};
  if (payload?.type !== "Event") return out;
  const inner = payload.value as { fields?: Array<{ name: string; value: JsonCDCValue }> };
  for (const f of inner.fields ?? []) {
    out[f.name] = f.value;
  }
  return out;
}

function cdcAddress(v: JsonCDCValue): string {
  return String(v.value).toLowerCase();
}

function cdcBigInt(v: JsonCDCValue): bigint {
  return BigInt(String(v.value));
}

function cdcByteArray(v: JsonCDCValue): Uint8Array {
  const arr = v.value as Array<JsonCDCValue>;
  const out = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = Number(arr[i]!.value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public scanner functions
// ---------------------------------------------------------------------------

export interface CadenceScannerOpts {
  accessApi?: string;
  fromBlock?: number;
  toBlock?: number;
}

export async function getLatestSealedHeight(accessApi: string = FLOW_CADENCE_ACCESS): Promise<number> {
  const res = await fetch(`${accessApi}/v1/blocks?height=sealed`);
  if (!res.ok) throw new Error(`getLatestSealedHeight: ${res.status} ${res.statusText}`);
  const data = await res.json() as Array<{ header: { height: string } }>;
  return Number(data[0]!.header.height);
}

async function fetchEvents(
  accessApi: string,
  eventType: string,
  fromBlock: number,
  toBlock: number
): Promise<CadenceEventResultRow[]> {
  const out: CadenceEventResultRow[] = [];
  for (let start = fromBlock; start <= toBlock; start += FLOW_EVENT_RANGE_MAX) {
    const end = Math.min(start + FLOW_EVENT_RANGE_MAX - 1, toBlock);
    const url = `${accessApi}/v1/events?type=${encodeURIComponent(eventType)}&start_height=${start}&end_height=${end}`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const rows = (await res.json()) as CadenceEventResultRow[];
    for (const row of rows) {
      if (row.events && row.events.length > 0) out.push(row);
    }
  }
  return out;
}

/**
 * Scan all snapshot-emitting events where `userAddress` is the actor.
 *
 * Returns self-directed snapshot blobs sorted by blockHeight ascending.
 *
 * Filtering rules per event type:
 *   - WrapWithSnapshot:   filter by `account` field == userAddress
 *   - UnwrapWithSnapshot: filter by `account` field == userAddress
 *   - ShieldedTransferWithSnapshot: NO address filter (event carries only
 *       commits, by privacy design). All events in the range are returned;
 *       the caller tries decryption on each — only the actor can decrypt
 *       their own `encryptedSnapshotFrom` blob.
 *
 * The encryptedSnapshotFrom + ephPubFromX/Y fields are mapped onto the
 * CadenceSnapshotEvent {ciphertext, ephPubkey} shape so downstream code
 * uses a uniform interface regardless of source event.
 */
export async function scanCadenceSnapshots(
  userAddress: string,
  contractAddress: string,
  contractName: string,
  opts?: CadenceScannerOpts
): Promise<CadenceSnapshotEvent[]> {
  const accessApi = opts?.accessApi ?? FLOW_CADENCE_ACCESS;
  const latest = opts?.toBlock ?? (await getLatestSealedHeight(accessApi));
  const fromBlock = opts?.fromBlock ?? Math.max(1, latest - DEFAULT_LOOKBACK);
  const addrHex = contractAddress.replace(/^0x/, "");
  const normalizedUser = userAddress.toLowerCase().startsWith("0x")
    ? userAddress.toLowerCase()
    : `0x${userAddress.toLowerCase()}`;

  const results: CadenceSnapshotEvent[] = [];

  // WrapWithSnapshot — filter by `account` field
  {
    const type = `A.${addrHex}.${contractName}.WrapWithSnapshot`;
    const rows = await fetchEvents(accessApi, type, fromBlock, latest);
    for (const row of rows) {
      const timestampMs = new Date(row.block_timestamp).getTime();
      const blockHeight = Number(row.block_height);
      for (const ev of row.events!) {
        try {
          const payload = JSON.parse(b64DecodeToString(ev.payload)) as JsonCDCValue;
          const fields = eventFieldsByName(payload);
          if (!fields.account || cdcAddress(fields.account) !== normalizedUser) continue;
          if (!fields.encryptedSnapshot || !fields.ephPubX || !fields.ephPubY) continue;
          results.push({
            ciphertext: cdcByteArray(fields.encryptedSnapshot),
            ephPubkey: { x: cdcBigInt(fields.ephPubX), y: cdcBigInt(fields.ephPubY) },
            timestampMs,
            txHash: ev.transaction_id,
            blockHeight,
            eventType: "wrap",
          });
        } catch {
          /* skip */
        }
      }
    }
  }

  // UnwrapWithSnapshot — filter by `account`
  {
    const type = `A.${addrHex}.${contractName}.UnwrapWithSnapshot`;
    const rows = await fetchEvents(accessApi, type, fromBlock, latest);
    for (const row of rows) {
      const timestampMs = new Date(row.block_timestamp).getTime();
      const blockHeight = Number(row.block_height);
      for (const ev of row.events!) {
        try {
          const payload = JSON.parse(b64DecodeToString(ev.payload)) as JsonCDCValue;
          const fields = eventFieldsByName(payload);
          if (!fields.account || cdcAddress(fields.account) !== normalizedUser) continue;
          if (!fields.encryptedSnapshot || !fields.ephPubX || !fields.ephPubY) continue;
          results.push({
            ciphertext: cdcByteArray(fields.encryptedSnapshot),
            ephPubkey: { x: cdcBigInt(fields.ephPubX), y: cdcBigInt(fields.ephPubY) },
            timestampMs,
            txHash: ev.transaction_id,
            blockHeight,
            eventType: "unwrap",
          });
        } catch {
          /* skip */
        }
      }
    }
  }

  // ShieldedTransferWithSnapshot — NO address filter, return all (caller decrypts)
  {
    const type = `A.${addrHex}.${contractName}.ShieldedTransferWithSnapshot`;
    const rows = await fetchEvents(accessApi, type, fromBlock, latest);
    for (const row of rows) {
      const timestampMs = new Date(row.block_timestamp).getTime();
      const blockHeight = Number(row.block_height);
      for (const ev of row.events!) {
        try {
          const payload = JSON.parse(b64DecodeToString(ev.payload)) as JsonCDCValue;
          const fields = eventFieldsByName(payload);
          // map the "From" suffixes to the canonical {ciphertext, ephPubkey} shape
          if (!fields.encryptedSnapshotFrom || !fields.ephPubFromX || !fields.ephPubFromY) continue;
          results.push({
            ciphertext: cdcByteArray(fields.encryptedSnapshotFrom),
            ephPubkey: { x: cdcBigInt(fields.ephPubFromX), y: cdcBigInt(fields.ephPubFromY) },
            timestampMs,
            txHash: ev.transaction_id,
            blockHeight,
            eventType: "shieldedTransfer",
          });
        } catch {
          /* skip */
        }
      }
    }
  }

  results.sort((a, b) => a.blockHeight - b.blockHeight);
  return results;
}

/**
 * Scan ShieldedTransferWithSnapshot events for incoming-note candidates.
 *
 * Privacy-design constraint: the event carries NO recipient address — only
 * the sender's commits and encrypted blobs. So we CANNOT pre-filter by
 * `recipientAddress`; we return every event in the window. The caller then
 * tries `decryptNoteTo(blob, ephPub, memoPrivKey)` on each — only the
 * intended recipient's memo privkey will successfully decrypt the blob.
 *
 * The `recipientAddress` arg is kept in the signature for API parity with
 * the EVM scanner, but it's currently a no-op marker (documented). A future
 * iteration could use a recipient memokey hint in a contract upgrade.
 */
export async function scanCadenceIncomingNotes(
  _recipientAddress: string,
  contractAddress: string,
  contractName: string,
  opts?: CadenceScannerOpts
): Promise<CadenceNoteEvent[]> {
  const accessApi = opts?.accessApi ?? FLOW_CADENCE_ACCESS;
  const latest = opts?.toBlock ?? (await getLatestSealedHeight(accessApi));
  const fromBlock = opts?.fromBlock ?? Math.max(1, latest - DEFAULT_LOOKBACK);
  const addrHex = contractAddress.replace(/^0x/, "");

  const eventType = `A.${addrHex}.${contractName}.ShieldedTransferWithSnapshot`;
  const rows = await fetchEvents(accessApi, eventType, fromBlock, latest);
  const results: CadenceNoteEvent[] = [];

  for (const row of rows) {
    const timestampMs = new Date(row.block_timestamp).getTime();
    const blockHeight = Number(row.block_height);
    for (const ev of row.events!) {
      try {
        const payload = JSON.parse(b64DecodeToString(ev.payload)) as JsonCDCValue;
        const fields = eventFieldsByName(payload);
        if (!fields.encryptedNoteTo || !fields.ephPubToX || !fields.ephPubToY) continue;
        results.push({
          ciphertext: cdcByteArray(fields.encryptedNoteTo),
          ephPubkey: { x: cdcBigInt(fields.ephPubToX), y: cdcBigInt(fields.ephPubToY) },
          timestampMs,
          txHash: ev.transaction_id,
          blockHeight,
        });
      } catch {
        /* skip */
      }
    }
  }

  results.sort((a, b) => a.blockHeight - b.blockHeight);
  return results;
}

/**
 * Find the per-user scan anchor for a JanusFT address.
 *
 * Strategy:
 *   1. Query the `FirstSnapshot` event for the given address starting from
 *      FIRST_SNAPSHOT_LIVE_BLOCK (the first block at which JanusFT emitted
 *      FirstSnapshot events). This window is small and fast on testnet.
 *   2. If a FirstSnapshot event is found for this address: return its `block`
 *      field (the Cadence block at which the user first interacted).
 *   3. If no event found: the user either never interacted OR they interacted
 *      between PROTOCOL_GENESIS_BLOCK and FIRST_SNAPSHOT_LIVE_BLOCK (before
 *      the event was live). Fall back to PROTOCOL_GENESIS_BLOCK so the caller
 *      scans from the contract deploy block forward — guaranteed to capture
 *      any wrap that happened after deployment.
 *
 * @returns `{ block, source }` — block is the Cadence scan start height as bigint;
 *   source is "event" if a FirstSnapshot event was found, "fallback" otherwise.
 */
export async function findFirstSnapshotBlock(
  userAddress: string,
  contractAddress: string,
  contractName: string,
  opts?: { accessApi?: string }
): Promise<{ block: bigint; source: "event" | "fallback" }> {
  const accessApi = opts?.accessApi ?? FLOW_CADENCE_ACCESS;
  const addrHex = contractAddress.replace(/^0x/, "");
  const normalizedUser = userAddress.toLowerCase().startsWith("0x")
    ? userAddress.toLowerCase()
    : `0x${userAddress.toLowerCase()}`;

  const eventType = `A.${addrHex}.${contractName}.FirstSnapshot`;
  const latest = await getLatestSealedHeight(accessApi);

  const searchFrom = Number(FIRST_SNAPSHOT_LIVE_BLOCK);
  if (latest < searchFrom) {
    // Chain hasn't reached the live block yet (unexpected on testnet) — use genesis fallback
    return { block: PROTOCOL_GENESIS_BLOCK, source: "fallback" };
  }

  // Search BACKWARDS from latest in 250-block windows. Most recently-active
  // users have FirstSnapshot events near the chain tip; reverse search finds
  // them in O(1) requests instead of O(N) for forward search through the full
  // FIRST_SNAPSHOT_LIVE_BLOCK → latest window (which hits Flow Access API rate
  // limits after ~500 sequential calls).
  for (let end = latest; end >= searchFrom; end -= FLOW_EVENT_RANGE_MAX) {
    const start = Math.max(searchFrom, end - FLOW_EVENT_RANGE_MAX + 1);
    const rows = await fetchEvents(accessApi, eventType, start, end);
    for (const row of rows) {
      for (const ev of row.events ?? []) {
        try {
          const payload = JSON.parse(b64DecodeToString(ev.payload)) as JsonCDCValue;
          const fields = eventFieldsByName(payload);
          if (!fields["account"] || cdcAddress(fields["account"]) !== normalizedUser) continue;
          if (!fields["block"]) continue;
          const blockNum = cdcBigInt(fields["block"]);
          return { block: blockNum, source: "event" };
        } catch {
          /* skip undecodable payloads */
        }
      }
    }
  }

  // No FirstSnapshot event for this address — use protocol genesis as fallback
  return { block: PROTOCOL_GENESIS_BLOCK, source: "fallback" };
}
