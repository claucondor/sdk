/**
 * scan/cadence-scanner.ts — Cadence event scanner for JanusMockFT.
 *
 * Uses Flow REST API to query Cadence events. Flow testnet caps event range
 * at 250 blocks per request, so this paginates aggressively.
 *
 * Events emitted by JanusMockFT (v0.6 contract):
 *   - A.{addr}.JanusMockFT.WrapWithSnapshot(account, grossAmount, netAmount,
 *       encryptedSnapshot, ephPubX, ephPubY)
 *   - A.{addr}.JanusMockFT.ShieldedTransferWithSnapshot(sender, recipient,
 *       encryptedSnapshot, ephPubX, ephPubY,
 *       encryptedNoteTo, ephPubToX, ephPubToY)
 *   - A.{addr}.JanusMockFT.UnwrapWithSnapshot(account, claimedAmount,
 *       recipient, encryptedSnapshot, ephPubX, ephPubY)
 *
 * Event payload encoding: Flow returns events as base64-encoded JSON-CDC.
 * We decode then walk the JSON to extract the encrypted blob + ephemeral pubkey.
 */

import type { DepositRecord } from "../types";
import { FLOW_CADENCE_ACCESS } from "../network/contracts";

const FLOW_EVENT_RANGE_MAX = 250; // testnet cap per /v1/events request
const DEFAULT_LOOKBACK = 250_000; // fallback when firstSnapshotBlock unknown

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
// JSON-CDC helpers (decode base64-CBOR → extract fields)
// ---------------------------------------------------------------------------

function b64DecodeToString(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

/**
 * Walk a Cadence composite/struct event payload and return a map of field
 * name → JSON-CDC value object.
 */
function eventFieldsByName(payload: JsonCDCValue): Record<string, JsonCDCValue> {
  // payload looks like: { type: "Event", value: { id: "A.X.JanusMockFT.WrapWithSnapshot",
  //   fields: [ { name: "account", value: {...} }, ...] } }
  const out: Record<string, JsonCDCValue> = {};
  if (payload?.type !== "Event") return out;
  const inner = payload.value as { fields?: Array<{ name: string; value: JsonCDCValue }> };
  for (const f of inner.fields ?? []) {
    out[f.name] = f.value;
  }
  return out;
}

/** Decode JSON-CDC Address ("0xNNN") to a normalized lowercase hex. */
function cdcAddress(v: JsonCDCValue): string {
  return String(v.value).toLowerCase();
}

/** Decode JSON-CDC UInt256/UInt as bigint. */
function cdcBigInt(v: JsonCDCValue): bigint {
  return BigInt(String(v.value));
}

/** Decode JSON-CDC [UInt8] array to Uint8Array. */
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
  /** Flow REST access node URL. Defaults to testnet. */
  accessApi?: string;
  /** Starting block (inclusive). Defaults to (latest - DEFAULT_LOOKBACK). */
  fromBlock?: number;
  /** Ending block (inclusive). Defaults to latest sealed. */
  toBlock?: number;
}

/**
 * Get the latest sealed block height.
 */
export async function getLatestSealedHeight(accessApi: string = FLOW_CADENCE_ACCESS): Promise<number> {
  const res = await fetch(`${accessApi}/v1/blocks?height=sealed`);
  if (!res.ok) throw new Error(`getLatestSealedHeight: ${res.status} ${res.statusText}`);
  const data = await res.json() as Array<{ header: { height: string } }>;
  return Number(data[0]!.header.height);
}

/**
 * Query events of a given fully-qualified type across a block range.
 * Internally paginates to obey the 250-block range cap.
 */
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
    if (!res.ok) {
      // Skip ranges that error (e.g. missing data) — don't crash the whole scan
      continue;
    }
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
 * Returns self-directed snapshot blobs (from WrapWithSnapshot,
 * UnwrapWithSnapshot, and ShieldedTransferWithSnapshot where user==sender),
 * sorted by blockHeight ascending.
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

  const eventTypes = [
    { type: `A.${addrHex}.${contractName}.WrapWithSnapshot`, kind: "wrap" as const, actorField: "account" },
    { type: `A.${addrHex}.${contractName}.ShieldedTransferWithSnapshot`, kind: "shieldedTransfer" as const, actorField: "sender" },
    { type: `A.${addrHex}.${contractName}.UnwrapWithSnapshot`, kind: "unwrap" as const, actorField: "account" },
  ];

  const results: CadenceSnapshotEvent[] = [];

  for (const { type, kind, actorField } of eventTypes) {
    const rows = await fetchEvents(accessApi, type, fromBlock, latest);
    for (const row of rows) {
      const timestampMs = new Date(row.block_timestamp).getTime();
      const blockHeight = Number(row.block_height);
      for (const ev of row.events!) {
        try {
          const payload = JSON.parse(b64DecodeToString(ev.payload)) as JsonCDCValue;
          const fields = eventFieldsByName(payload);
          if (!fields[actorField]) continue;
          // Only count events for our user
          if (cdcAddress(fields[actorField]!) !== normalizedUser) continue;
          if (!fields.encryptedSnapshot || !fields.ephPubX || !fields.ephPubY) continue;
          results.push({
            ciphertext: cdcByteArray(fields.encryptedSnapshot),
            ephPubkey: { x: cdcBigInt(fields.ephPubX), y: cdcBigInt(fields.ephPubY) },
            timestampMs,
            txHash: ev.transaction_id,
            blockHeight,
            eventType: kind,
          });
        } catch {
          // skip undecodable
        }
      }
    }
  }

  results.sort((a, b) => a.blockHeight - b.blockHeight);
  return results;
}

/**
 * Scan ShieldedTransferWithSnapshot events where userAddress is the recipient.
 * Returns the note-to-recipient blobs (encryptedNoteTo + its ephemeral),
 * sorted by blockHeight ascending.
 */
export async function scanCadenceIncomingNotes(
  recipientAddress: string,
  contractAddress: string,
  contractName: string,
  opts?: CadenceScannerOpts
): Promise<CadenceNoteEvent[]> {
  const accessApi = opts?.accessApi ?? FLOW_CADENCE_ACCESS;
  const latest = opts?.toBlock ?? (await getLatestSealedHeight(accessApi));
  const fromBlock = opts?.fromBlock ?? Math.max(1, latest - DEFAULT_LOOKBACK);
  const addrHex = contractAddress.replace(/^0x/, "");
  const normalizedRecipient = recipientAddress.toLowerCase().startsWith("0x")
    ? recipientAddress.toLowerCase()
    : `0x${recipientAddress.toLowerCase()}`;

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
        if (!fields.recipient) continue;
        if (cdcAddress(fields.recipient!) !== normalizedRecipient) continue;
        if (!fields.encryptedNoteTo || !fields.ephPubToX || !fields.ephPubToY) continue;
        results.push({
          ciphertext: cdcByteArray(fields.encryptedNoteTo),
          ephPubkey: { x: cdcBigInt(fields.ephPubToX), y: cdcBigInt(fields.ephPubToY) },
          timestampMs,
          txHash: ev.transaction_id,
          blockHeight,
        });
      } catch {
        // skip
      }
    }
  }

  results.sort((a, b) => a.blockHeight - b.blockHeight);
  return results;
}
