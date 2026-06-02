/**
 * Live read-only integration test against testnet.
 *
 * Verifies each adapter reads on-chain state correctly for all 4 tokens.
 * No transactions submitted. Uses the SDK's adapter interface directly.
 *
 * Run: cd /home/oydual3/openjanus-sdk && node tests/integration/run-live-reads.mjs
 *
 * Outputs a JSON results file at tests/integration/live-reads-results.json.
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, "live-reads-results.json");

// Use the compiled dist (so this script doesn't depend on TS loader)
const sdkPath = join(__dirname, "..", "..", "dist", "index.js");
const { sdk } = await import(sdkPath);

const ACTORS = {
  alice:   { evm: "0x000000000000000000000002b7557ee5d4a32d06", cadence: "0x7599043aea001283" },
  bob:     { evm: "0x00000000000000000000000250d93efba617e0bf", cadence: "0xd807a3992d7be612" },
  charlie: { evm: "0x00000000000000000000000249065458581f9bf0", cadence: "0x3c601a443c81e6cd" },
  dave:    { evm: "0x0000000000000000000000027b94cfc8a64971cd", cadence: "0xd32d9100e1fe983b" },
};

const results = { startedAt: new Date().toISOString(), tests: [] };
let passed = 0, failed = 0;

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const got = await fn();
    console.log("PASS", typeof got === "string" ? `(${got.slice(0, 60)})` : "");
    results.tests.push({ name, status: "PASS", evidence: typeof got === "object" ? JSON.stringify(got).slice(0, 200) : String(got) });
    passed++;
  } catch (e) {
    console.log("FAIL:", e.message.slice(0, 120));
    results.tests.push({ name, status: "FAIL", error: e.message.slice(0, 300) });
    failed++;
  }
}

console.log("=== EVM adapter reads ===");
for (const id of ["flow", "wflow", "mockusdc"]) {
  const adapter = sdk.token(id);
  console.log(`\n--- ${id} (${adapter.variant}) at ${adapter.address} ---`);

  await test(`${id}: feeBps in [0,100]`, async () => {
    const bps = await adapter.feeBps();
    if (typeof bps !== "number" || bps < 0 || bps > 100) throw new Error(`bad bps: ${bps}`);
    return `feeBps=${bps}`;
  });

  await test(`${id}: feeRecipient is 0x address`, async () => {
    const addr = await adapter.feeRecipient();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`bad addr: ${addr}`);
    return addr;
  });

  await test(`${id}: getCommitment(zero) doesn't throw`, async () => {
    const c = await adapter.getCommitment("0x0000000000000000000000000000000000000000");
    if (typeof c.x !== "bigint") throw new Error(`bad commitment: ${JSON.stringify(c)}`);
    return `(${c.x}, ${c.y})`;
  });

  await test(`${id}: getMemoKey(zero) returns null`, async () => {
    const k = await adapter.getMemoKey("0x0000000000000000000000000000000000000000");
    if (k !== null) throw new Error(`expected null, got ${JSON.stringify(k)}`);
    return "null";
  });

  await test(`${id}: getFirstSnapshotBlock(zero) returns 0`, async () => {
    const b = await adapter.getFirstSnapshotBlock("0x0000000000000000000000000000000000000000");
    if (b !== 0n) throw new Error(`expected 0n, got ${b}`);
    return "0n";
  });

  await test(`${id}: computeNet(1e18) returns net <= 1e18`, async () => {
    const net = await adapter.computeNet(1_000_000_000_000_000_000n);
    if (net > 1_000_000_000_000_000_000n || net <= 0n) throw new Error(`bad net: ${net}`);
    return `net=${net}`;
  });

  await test(`${id}: getCommitment(alice COA) works`, async () => {
    const c = await adapter.getCommitment(ACTORS.alice.evm);
    return `(x=${c.x.toString().slice(0,20)}..., y=${c.y.toString().slice(0,20)}...)`;
  });

  await test(`${id}: getMemoKey(alice COA) returns null or valid {x,y}`, async () => {
    const k = await adapter.getMemoKey(ACTORS.alice.evm);
    if (k === null) return "null (not registered)";
    if (typeof k.x !== "bigint" || typeof k.y !== "bigint") throw new Error(`bad shape: ${JSON.stringify(k)}`);
    return `(x=${k.x.toString().slice(0,20)}..., y=${k.y.toString().slice(0,20)}...)`;
  });
}

console.log("\n=== Cadence adapter reads (mockft) ===");
const mockft = sdk.token("mockft");
console.log(`--- mockft (${mockft.variant}) at ${mockft.address} ---`);

await test("mockft: feeBps in [0,100]", async () => {
  const bps = await mockft.feeBps();
  if (typeof bps !== "number" || bps < 0 || bps > 100) throw new Error(`bad bps: ${bps}`);
  return `feeBps=${bps}`;
});

await test("mockft: feeRecipient is a Flow address", async () => {
  const addr = await mockft.feeRecipient();
  if (!/^0x[0-9a-fA-F]+$/.test(addr)) throw new Error(`bad addr: ${addr}`);
  return addr;
});

await test("mockft: getCommitment(alice) doesn't throw", async () => {
  const c = await mockft.getCommitment(ACTORS.alice.cadence);
  return `(x=${c.x.toString().slice(0,20)}..., y=${c.y.toString().slice(0,20)}...)`;
});

await test("mockft: getMemoKey(alice) returns null or valid", async () => {
  const k = await mockft.getMemoKey(ACTORS.alice.cadence);
  if (k === null) return "null";
  return `x=${k.x.toString().slice(0,16)}...`;
});

console.log("\n=== Cadence event scanner (live) ===");
const { scanCadenceSnapshots, getLatestSealedHeight } = await import(
  join(__dirname, "..", "..", "dist", "scan", "index.js")
);

await test("getLatestSealedHeight reaches mainnet REST API", async () => {
  const h = await getLatestSealedHeight();
  if (h < 320000000) throw new Error(`block too low: ${h}`);
  return `height=${h}`;
});

await test("scanCadenceSnapshots(alice, mockft) over last 200 blocks doesn't throw", async () => {
  const latest = await getLatestSealedHeight();
  const events = await scanCadenceSnapshots(
    ACTORS.alice.cadence,
    "0x7599043aea001283",
    "JanusMockFT",
    { fromBlock: latest - 200, toBlock: latest }
  );
  return `events_found=${events.length}`;
});

results.finishedAt = new Date().toISOString();
results.summary = { passed, failed, total: passed + failed };
writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
console.log(`\n=== Summary: ${passed} PASS, ${failed} FAIL ===`);
console.log(`Results saved to ${OUTPUT}`);
if (failed > 0) process.exit(1);
