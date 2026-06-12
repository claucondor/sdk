/**
 * session/MemoKeySession.ts — Browser-only session-scoped MemoKey privkey cache.
 *
 * Promoted verbatim from private-tip-v1/web/lib/memo-key-session.ts.
 *
 * The BabyJub privkey is derived from the user's wallet signature once per
 * browser SESSION and held in sessionStorage. Cleared when the tab closes —
 * the user re-signs to recover in the next session.
 *
 * Trade-off: sessionStorage gives "no disk persistence of the secret" without
 * forcing a wallet popup on every page navigation. The cost is one signature
 * per browser session (tab lifetime).
 *
 * WITHOUT THIS: every page navigation that needs the privkey triggers a new
 * wallet signature popup, degrading UX. Any Janus app with multi-page
 * navigation WILL re-discover this independently.
 *
 * @browser-only — Uses sessionStorage; returns null in Node.js / SSR contexts.
 * @module @claucondor/sdk/session
 */

const SESSION_PREFIX = "openjanus:memo-privkey-session:";

function _storageKey(addr: string): string {
  return `${SESSION_PREFIX}${addr.toLowerCase()}`;
}

/**
 * Retrieve a cached BabyJub privkey for `addr` from sessionStorage.
 * Returns null in Node.js / SSR contexts.
 */
export function getCachedMemoPrivkey(addr: string): bigint | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(_storageKey(addr));
  return raw ? BigInt(raw) : null;
}

/**
 * Persist a BabyJub privkey for `addr` into sessionStorage.
 * No-op in Node.js / SSR contexts.
 */
export function cacheMemoPrivkey(addr: string, privkey: bigint): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(_storageKey(addr), privkey.toString());
}

/**
 * Remove the cached BabyJub privkey for `addr` from sessionStorage.
 * No-op in Node.js / SSR contexts.
 */
export function clearMemoPrivkeyCache(addr: string): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(_storageKey(addr));
}

/**
 * Class-based API wrapping the three standalone functions.
 *
 * Prefer this when injecting the session cache as a dependency, e.g.
 * in a service/context class that needs to be testable with a mock storage.
 *
 * @browser-only — All methods are no-ops in Node.js / SSR.
 *
 * @example
 *   const session = new MemoKeySession();
 *   const privkey = session.get(flowAddr) ?? (await deriveAndCache(flowAddr));
 *
 *   // In tests (mock sessionStorage):
 *   global.sessionStorage = new MockStorage();
 *   const session = new MemoKeySession();
 */
export class MemoKeySession {
  /**
   * Get the cached memo privkey for `addr`. Returns null if not cached or in SSR.
   */
  get(addr: string): bigint | null {
    return getCachedMemoPrivkey(addr);
  }

  /**
   * Cache `privkey` for `addr` in sessionStorage.
   */
  set(addr: string, privkey: bigint): void {
    cacheMemoPrivkey(addr, privkey);
  }

  /**
   * Remove the cached privkey for `addr`.
   */
  clear(addr: string): void {
    clearMemoPrivkeyCache(addr);
  }
}
