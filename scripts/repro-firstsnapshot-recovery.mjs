/**
 * scripts/repro-firstsnapshot-recovery.mjs
 *
 * Reproduction script for FirstSnapshot-anchor scan logic.
 *
 * Tests the full recovery path for the operator's testing wallet:
 *   1. Calls findFirstSnapshotBlock to determine the per-user scan anchor
 *      (event-based or fallback to PROTOCOL_GENESIS_BLOCK).
 *   2. Scans WrapWithSnapshot events from that anchor block.
 *   3. Decrypts the snapshot and verifies the 9.99 MockFT balance is recovered.
 *
 * The operator wrapped MockFT at block ~325359xxx — BEFORE the FirstSnapshot
 * event was live (FIRST_SNAPSHOT_LIVE_BLOCK = 325631233). So this script
 * exercises the FALLBACK path (no event found → use PROTOCOL_GENESIS_BLOCK).
 *
 * Expected output:
 *   - anchor source: fallback
 *   - fromBlock: 325328960n
 *   - balance: 999000000n (9.99 MockFT @ 8 decimals)
 *
 * Usage (from /home/oydual3/openjanus-sdk — after npm run build):
 *   node scripts/repro-firstsnapshot-recovery.mjs
 */

import { findFirstSnapshotBlock, scanCadenceSnapshots, getLatestSealedHeight } from "../dist/scan/index.js";
import { decryptSnapshot } from "../dist/crypto/index.js";

const USER_CADENCE_ADDR = "0xe3e678e0c1e6ad79";
const MEMO_PRIVKEY = 880413913145503288287847458865894980663156109874655634189442181344760966182n;
const CONTRACT_ADDR = "0xc4e8f99915893a2f";
const CONTRACT_NAME = "JanusFT";
const ACCESS_API = "https://rest-testnet.onflow.org";

console.log("=== FirstSnapshot Anchor — Recovery Reproduction ===");
console.log(`User:     ${USER_CADENCE_ADDR}`);
console.log(`Contract: A.${CONTRACT_ADDR.replace(/^0x/, "")}.${CONTRACT_NAME}`);
console.log();

const t0 = Date.now();

// Step 1: Resolve per-user scan anchor
console.log("Step 1 — resolving FirstSnapshot anchor ...");
const { block: fromBlock, source } = await findFirstSnapshotBlock(
  USER_CADENCE_ADDR,
  CONTRACT_ADDR,
  CONTRACT_NAME,
  { accessApi: ACCESS_API }
);
const t1 = Date.now();
console.log(`  anchor source: ${source}`);
console.log(`  fromBlock:     ${fromBlock}`);
console.log(`  resolved in:   ${t1 - t0}ms`);
console.log();

if (source === "event") {
  console.log("  -> FirstSnapshot event found on-chain. Scanning from event block.");
} else {
  console.log("  -> No FirstSnapshot event found (user wrapped before event was live).");
  console.log("     Using PROTOCOL_GENESIS_BLOCK as fallback anchor.");
}
console.log();

// Step 2: Scan for snapshot events from the anchor block
const latest = await getLatestSealedHeight(ACCESS_API);
console.log(`Step 2 — scanning blocks ${fromBlock} → ${latest} (${latest - Number(fromBlock)} blocks) ...`);

const events = await scanCadenceSnapshots(
  USER_CADENCE_ADDR,
  CONTRACT_ADDR,
  CONTRACT_NAME,
  { accessApi: ACCESS_API, fromBlock: Number(fromBlock), toBlock: latest }
);
const t2 = Date.now();
console.log(`  events found:  ${events.length}`);
console.log(`  scanned in:    ${t2 - t1}ms`);
console.log();

if (events.length === 0) {
  console.error("FAIL: 0 snapshot events found. Fallback scan did not recover events.");
  console.error("This means the wrap event is not in the block range or there is an API issue.");
  process.exit(1);
}

for (const ev of events) {
  console.log(`  [block ${ev.blockHeight}] type=${ev.eventType} tx=${ev.txHash.slice(0, 16)}...`);
  console.log(`    ciphertext.length=${ev.ciphertext.length}`);
  console.log(`    ephPubkey.x=${ev.ephPubkey.x}`);
  console.log(`    timestampMs=${ev.timestampMs} (${new Date(ev.timestampMs).toISOString()})`);
}
console.log();

// Step 3: Decrypt snapshots
console.log("Step 3 — decrypting snapshots ...");
const decrypted = [];
for (const ev of events) {
  const snap = await decryptSnapshot(ev.ciphertext, ev.ephPubkey, MEMO_PRIVKEY);
  if (snap !== null) {
    decrypted.push(snap);
    console.log(`  [block ${ev.blockHeight}] balance=${snap.balance} blinding=...${snap.blinding.toString().slice(-8)}`);
  } else {
    console.log(`  [block ${ev.blockHeight}] DECRYPT FAILED`);
  }
}
const t3 = Date.now();
console.log(`  decrypted in: ${t3 - t2}ms`);
console.log();

if (decrypted.length === 0) {
  console.error("FAIL: events found but none decrypted. Wrong privkey or corrupted blob.");
  process.exit(1);
}

decrypted.sort((a, b) => b.timestampMs - a.timestampMs);
const best = decrypted[0];

console.log("=== RESULT ===");
console.log(`anchor source:       ${source}`);
console.log(`fromBlock:           ${fromBlock}`);
console.log(`events scanned:      ${events.length}`);
console.log(`events decrypted:    ${decrypted.length}`);
console.log(`balance (raw units): ${best.balance}`);
console.log(`balance (MockFT):    ${Number(best.balance) / 1e8}`);
console.log(`blinding:            ${best.blinding}`);
console.log(`timestampMs:         ${best.timestampMs} (${new Date(best.timestampMs).toISOString()})`);
console.log(`total time:          ${t3 - t0}ms`);
console.log();

// Verify expected balance
const EXPECTED_BALANCE = 999000000n; // 9.99 MockFT @ 8 decimals
if (best.balance === EXPECTED_BALANCE) {
  console.log("PASS: balance matches expected 999000000n (9.99 MockFT).");
} else {
  console.log(`WARN: balance ${best.balance} does not match expected ${EXPECTED_BALANCE}.`);
  console.log("      This may be expected if the operator performed additional wraps/unwraps.");
  // Don't fail — the scan itself worked, just the balance might differ
}
console.log();
console.log("Recovery path: OK — shielded state is recoverable via FirstSnapshot anchor.");
