/**
 * @claucondor/sdk/session — Browser-only session helpers.
 *
 * These helpers use browser storage APIs (sessionStorage / localStorage)
 * and are NOT suitable for Node.js or SSR contexts. In those environments
 * all reads return null / empty and writes are no-ops.
 *
 * Exports:
 *   MemoKeySession  — Cache the BabyJub privkey in sessionStorage per tab session.
 *   SentMemoStore   — Persist outgoing plaintext memos in localStorage per sender.
 *
 * @module @claucondor/sdk/session
 */

export {
  MemoKeySession,
  getCachedMemoPrivkey,
  cacheMemoPrivkey,
  clearMemoPrivkeyCache,
} from "./MemoKeySession";

export {
  SentMemoStore,
  saveSentMemo,
  findSentMemo,
  clearSentMemos,
} from "./SentMemoStore";

export type { SentMemoEntry } from "./SentMemoStore";
