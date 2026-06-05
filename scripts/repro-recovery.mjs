/**
 * scripts/repro-recovery.mjs
 *
 * Reproduction script for the MockFT recovery bug.
 * Runs the exact code path the front would call:
 *   sdk.token("mockft").latestSnapshot(userCadenceAddr, memoPrivKey)
 *
 * Usage (from /home/oydual3/openjanus-sdk):
 *   node scripts/repro-recovery.mjs
 *
 * Expected on success: 1 event found, balance = 999000000n (9.99 MockFT in 10^8 units)
 */

import { scanCadenceSnapshots, getLatestSealedHeight } from "../dist/scan/index.js";
import { decryptSnapshot } from "../dist/crypto/index.js";

const USER_CADENCE_ADDR = "0xe3e678e0c1e6ad79";
const MEMO_PRIVKEY = 880413913145503288287847458865894980663156109874655634189442181344760966182n;
const CONTRACT_ADDR = "0xc4e8f99915893a2f";
const CONTRACT_NAME = "JanusFT";
const ACCESS_API = "https://rest-testnet.onflow.org";

// Scan from a wide enough window — wrap happened today (2026-06-05).
// Use 20000 block lookback to be safe.
const LOOKBACK = 20_000;

console.log("=== MockFT Recovery Reproduction ===");
console.log(`User: ${USER_CADENCE_ADDR}`);
console.log(`Contract: A.${CONTRACT_ADDR.replace(/^0x/, "")}.${CONTRACT_NAME}`);
console.log(`Privkey: ${MEMO_PRIVKEY}`);
console.log();

const latest = await getLatestSealedHeight(ACCESS_API);
const fromBlock = Math.max(1, latest - LOOKBACK);
console.log(`Latest sealed block: ${latest}`);
console.log(`Scanning blocks ${fromBlock} → ${latest} (${latest - fromBlock} blocks)`);
console.log();

const events = await scanCadenceSnapshots(
  USER_CADENCE_ADDR,
  CONTRACT_ADDR,
  CONTRACT_NAME,
  { accessApi: ACCESS_API, fromBlock, toBlock: latest }
);

console.log(`Events found: ${events.length}`);
if (events.length === 0) {
  console.log("BUG CLASS: scan — 0 events returned for this user.");
  process.exit(1);
}

for (const ev of events) {
  console.log(`  [block ${ev.blockHeight}] type=${ev.eventType} txHash=${ev.txHash}`);
  console.log(`    ciphertext.length=${ev.ciphertext.length}`);
  console.log(`    ephPubkey.x=${ev.ephPubkey.x}`);
  console.log(`    ephPubkey.y=${ev.ephPubkey.y}`);
  console.log(`    timestampMs=${ev.timestampMs} (${new Date(ev.timestampMs).toISOString()})`);
}
console.log();

// Try decryption
const decrypted = [];
for (const ev of events) {
  const snap = await decryptSnapshot(ev.ciphertext, ev.ephPubkey, MEMO_PRIVKEY);
  if (snap !== null) {
    console.log(`  Decrypted: balance=${snap.balance} blinding=${snap.blinding} timestampMs=${snap.timestampMs}`);
    decrypted.push(snap);
  } else {
    console.log(`  [block ${ev.blockHeight}] DECRYPT FAILED — null returned`);
  }
}

if (decrypted.length === 0) {
  console.log("BUG CLASS: decrypt — events found but none decrypted.");
  process.exit(1);
}

decrypted.sort((a, b) => b.timestampMs - a.timestampMs);
const latest_snap = decrypted[0];
console.log();
console.log("=== RESULT ===");
console.log(`balance (raw 10^8 units): ${latest_snap.balance}`);
console.log(`balance (MockFT): ${Number(latest_snap.balance) / 1e8}`);
console.log(`blinding: ${latest_snap.blinding}`);
console.log(`timestampMs: ${latest_snap.timestampMs}`);
console.log();
console.log("Recovery path: OK — funds are recoverable.");
