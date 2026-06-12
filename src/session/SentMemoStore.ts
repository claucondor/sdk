/**
 * session/SentMemoStore.ts — Browser-only sender-side memo mirror.
 *
 * Promoted verbatim from private-tip-v1/web/lib/memo-mirror.ts.
 *
 * On-chain memos are ECIES-encrypted to the RECIPIENT's MemoKey pubkey, so
 * the SENDER cannot decrypt them after the fact. To let the sender see their
 * own outgoing memos in a "Sent" view, we persist the plaintext locally
 * (per-sender, in localStorage) at send time and look it up when rendering.
 *
 * Match strategy: join on (recipient, timestamp ± MATCH_WINDOW_SEC). On-chain
 * timestamps come from Cadence block time (Unix seconds), which lands within a
 * few seconds of the local clock.
 *
 * WITHOUT THIS: any app with a "Sent" view re-implements this localStorage
 * pattern with slightly different key formats, creating incompatibility across
 * Janus apps sharing the same browser storage.
 *
 * @browser-only — Uses localStorage; returns empty results in Node.js / SSR.
 * @module @claucondor/sdk/session
 */

const MIRROR_KEY_PREFIX = "openjanus:memo-mirror:";

/** Time window (±seconds) within which we consider an on-chain timestamp to
 *  match a locally-stored sentAtMs. Cadence block time ≈ local clock. */
const MATCH_WINDOW_SEC = 120;

export interface SentMemoEntry {
  /** Flow address of the recipient, lowercased. */
  recipient: string;
  /** Plaintext memo as provided by the sender. */
  memo: string;
  /** Date.now() captured at send time (milliseconds). */
  sentAtMs: number;
}

function _storageKey(sender: string): string {
  return `${MIRROR_KEY_PREFIX}${sender.toLowerCase()}`;
}

function _load(sender: string): SentMemoEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(_storageKey(sender));
    return raw ? (JSON.parse(raw) as SentMemoEntry[]) : [];
  } catch {
    return [];
  }
}

function _save(sender: string, entries: SentMemoEntry[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(_storageKey(sender), JSON.stringify(entries));
}

/**
 * Persist a plaintext memo for a sent shielded tip so the sender can display it later.
 *
 * Call this immediately after a successful `sendTip` / `shieldedTransfer` tx.
 * No-op if `opts.memo` is empty.
 *
 * @param opts.sender    Sender's Flow address (any casing; stored lowercased).
 * @param opts.recipient Recipient's Flow address (any casing; stored lowercased).
 * @param opts.memo      Plaintext memo string.
 * @param opts.sentAtMs  Optional override for send timestamp (default: Date.now()).
 */
export function saveSentMemo(opts: {
  sender: string;
  recipient: string;
  memo: string;
  sentAtMs?: number;
}): void {
  if (!opts.memo) return;
  const entries = _load(opts.sender);
  entries.push({
    recipient: opts.recipient.toLowerCase(),
    memo: opts.memo,
    sentAtMs: opts.sentAtMs ?? Date.now(),
  });
  _save(opts.sender, entries);
}

/**
 * Look up a previously-saved memo for a Sent tip.
 * Joins on recipient address and a ±MATCH_WINDOW_SEC window around the on-chain
 * timestamp. Returns the closest-matching memo string, or null if none found.
 *
 * @param opts.sender              Sender's Flow address.
 * @param opts.recipient           Recipient's Flow address.
 * @param opts.onChainTimestampSec On-chain block timestamp in UNIX seconds.
 * @returns                        Closest-matching memo string, or null.
 */
export function findSentMemo(opts: {
  sender: string;
  recipient: string;
  onChainTimestampSec: number;
}): string | null {
  const entries = _load(opts.sender);
  const recip = opts.recipient.toLowerCase();
  const targetMs = opts.onChainTimestampSec * 1000;
  let best: { entry: SentMemoEntry; deltaMs: number } | null = null;
  for (const e of entries) {
    if (e.recipient !== recip) continue;
    const delta = Math.abs(e.sentAtMs - targetMs);
    if (delta > MATCH_WINDOW_SEC * 1000) continue;
    if (!best || delta < best.deltaMs) {
      best = { entry: e, deltaMs: delta };
    }
  }
  return best ? best.entry.memo : null;
}

/**
 * Wipe the local memo mirror for `sender` (testing / privacy reset).
 */
export function clearSentMemos(sender: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(_storageKey(sender));
}

/**
 * Class-based API wrapping the three standalone functions.
 *
 * Prefer this for dependency injection or when you need to namespace operations
 * by sender without passing the sender address to every call.
 *
 * @browser-only — All methods no-op in Node.js / SSR.
 *
 * @example
 *   const store = new SentMemoStore(myFlowAddr);
 *   store.save({ recipient, memo });
 *   const text = store.find({ recipient, onChainTimestampSec: blockTs });
 */
export class SentMemoStore {
  private readonly sender: string;

  /**
   * @param senderAddr  Sender's Flow address. All operations are scoped to this address.
   */
  constructor(senderAddr: string) {
    this.sender = senderAddr;
  }

  /**
   * Persist a plaintext memo for an outgoing tip.
   */
  save(opts: { recipient: string; memo: string; sentAtMs?: number }): void {
    saveSentMemo({ sender: this.sender, ...opts });
  }

  /**
   * Find the closest-matching memo for a received Sent tip.
   */
  find(opts: { recipient: string; onChainTimestampSec: number }): string | null {
    return findSentMemo({ sender: this.sender, ...opts });
  }

  /**
   * Wipe all locally-stored memos for this sender.
   */
  clear(): void {
    clearSentMemos(this.sender);
  }
}
