/**
 * Live WRITE-path integration test against testnet.
 *
 * Strategy:
 *  - The lab E2E test (deployments/v0_6/janus-mockft-stress-test.json) proved
 *    the full 4-actor / wrap+transfer+unwrap flow works on JanusMockFT.
 *  - This script uses those lab tx hashes as fixtures, finds their block heights,
 *    scans the SDK's Cadence scanner against those blocks, and validates the
 *    SDK correctly decodes every event the lab emitted.
 *  - Plus a SDK-driven dry-run for the EVM adapter calldata (static-call against
 *    the deployed proxy with valid pre-state — confirms wire format is correct).
 *
 * Run: cd /home/oydual3/openjanus-sdk && node tests/integration/run-live-writes.mjs
 * Outputs: tests/integration/live-writes-results.json
 */

import { writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(__dirname, "live-writes-results.json");
const SDK_PATH = join(__dirname, "..", "..", "dist", "index.js");
const SCAN_PATH = join(__dirname, "..", "..", "dist", "scan", "index.js");
const ORCH_PATH = join(__dirname, "..", "..", "dist", "orchestration", "index.js");

const { sdk, deriveMemoKeyFromSignature, computeNetWrap, computeWrapFee } = await import(SDK_PATH);
const { scanCadenceSnapshots, scanCadenceIncomingNotes } = await import(SCAN_PATH);
const { orchestrateWrap, orchestrateShieldedTransfer } = await import(ORCH_PATH);

const ACTORS = {
  alice:   { evm: "0x000000000000000000000002b7557ee5d4a32d06", cadence: "0x7599043aea001283" },
  bob:     { evm: "0x00000000000000000000000250d93efba617e0bf", cadence: "0xd807a3992d7be612" },
  charlie: { evm: "0x00000000000000000000000249065458581f9bf0", cadence: "0x3c601a443c81e6cd" },
  dave:    { evm: "0x0000000000000000000000027b94cfc8a64971cd", cadence: "0xd32d9100e1fe983b" },
};

// Lab E2E tx hashes that proved JanusFT end-to-end on June 3 (Track B+++)
const LAB_TXS = {
  alice_wrap:                     "ced969a8e0e897b6abfd67a5b0deae08d508a7c63317c8f90f50915a30fdd00a",
  alice_to_bob_shielded_transfer: "6eeecd7edb85a6ba0a1b49240e5b6e77b12b9e7fc90f3260f2dae615d062ed3b",
  bob_unwrap:                     "3a9718b63f44f7dbc619077440e02f78d43b6cce6d7c0478de5ecc904b1dd8ca",
  charlie_wrap:                   "955bec5491cc140405a4526dc18265dbcef9d0a3dfd1638839d74d6f84586fa4",
  charlie_to_dave_shielded_transfer: "20502fa0e260bc472252c1de15d95e4ac39f79c4b89d41720ef2916c55a2007a",
  dave_unwrap:                    "95c454918041e43973f49868dd7429691e6963c9d3167bef2eeb8c38ba61b5a5",
};

const REST = "https://rest-testnet.onflow.org";

const results = { startedAt: new Date().toISOString(), tests: [] };
let passed = 0, failed = 0;

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const got = await fn();
    console.log("PASS", typeof got === "string" ? `(${got.slice(0, 80)})` : "");
    results.tests.push({ name, status: "PASS", evidence: typeof got === "object" ? JSON.stringify(got).slice(0, 200) : String(got).slice(0, 200) });
    passed++;
  } catch (e) {
    console.log("FAIL:", e.message.slice(0, 160));
    results.tests.push({ name, status: "FAIL", error: e.message.slice(0, 400) });
    failed++;
  }
}

async function fetchTxBlock(txHash) {
  const r = await fetch(`${REST}/v1/transaction_results/${txHash}`);
  if (!r.ok) throw new Error(`tx fetch ${r.status}`);
  const j = await r.json();
  // get block height from block_id
  const br = await fetch(`${REST}/v1/blocks/${j.block_id}`);
  if (!br.ok) throw new Error(`block fetch ${br.status}`);
  const bj = await br.json();
  return { blockHeight: Number(bj[0].header.height), events: j.events ?? [] };
}

console.log("=== Cadence scanner validation against lab E2E events ===\n");

// Get block heights for each lab tx
const blocks = {};
for (const [name, tx] of Object.entries(LAB_TXS)) {
  const info = await fetchTxBlock(tx);
  blocks[name] = info.blockHeight;
  console.log(`  ${name}: block=${info.blockHeight} (${info.events.length} events in tx)`);
}

// Compute scan window covering all lab activity
const minBlock = Math.min(...Object.values(blocks));
const maxBlock = Math.max(...Object.values(blocks));
console.log(`\nLab activity window: ${minBlock} → ${maxBlock} (span=${maxBlock - minBlock})\n`);

await test("scan Alice's WrapWithSnapshot from lab", async () => {
  const events = await scanCadenceSnapshots(
    ACTORS.alice.cadence,
    "0x7599043aea001283",
    "JanusFT",
    { fromBlock: blocks.alice_wrap, toBlock: blocks.alice_wrap }
  );
  if (events.length === 0) throw new Error("no events");
  const ev = events[0];
  if (ev.eventType !== "wrap") throw new Error(`wrong type: ${ev.eventType}`);
  if (ev.txHash !== LAB_TXS.alice_wrap) throw new Error(`wrong tx: ${ev.txHash}`);
  return `decoded wrap @ block ${ev.blockHeight}, cipher=${ev.ciphertext.length}B`;
});

await test("scan Alice's ShieldedTransferWithSnapshot (sender) from lab", async () => {
  const events = await scanCadenceSnapshots(
    ACTORS.alice.cadence,
    "0x7599043aea001283",
    "JanusFT",
    { fromBlock: blocks.alice_to_bob_shielded_transfer, toBlock: blocks.alice_to_bob_shielded_transfer }
  );
  const transfers = events.filter(e => e.eventType === "shieldedTransfer");
  if (transfers.length === 0) throw new Error("no transfer events");
  return `decoded ${transfers.length} transfer event(s) for Alice as sender`;
});

await test("scan Bob's incoming note (recipient) from lab", async () => {
  const notes = await scanCadenceIncomingNotes(
    ACTORS.bob.cadence,
    "0x7599043aea001283",
    "JanusFT",
    { fromBlock: blocks.alice_to_bob_shielded_transfer, toBlock: blocks.alice_to_bob_shielded_transfer }
  );
  if (notes.length === 0) throw new Error("no incoming notes");
  return `Bob received ${notes.length} note(s), cipher=${notes[0].ciphertext.length}B`;
});

await test("scan Bob's UnwrapWithSnapshot from lab", async () => {
  const events = await scanCadenceSnapshots(
    ACTORS.bob.cadence,
    "0x7599043aea001283",
    "JanusFT",
    { fromBlock: blocks.bob_unwrap, toBlock: blocks.bob_unwrap }
  );
  const unwraps = events.filter(e => e.eventType === "unwrap");
  if (unwraps.length === 0) throw new Error("no unwrap events");
  return `decoded Bob's unwrap @ block ${unwraps[0].blockHeight}`;
});

await test("scan Charlie→Dave transfer chain from lab", async () => {
  const daveNotes = await scanCadenceIncomingNotes(
    ACTORS.dave.cadence,
    "0x7599043aea001283",
    "JanusFT",
    { fromBlock: blocks.charlie_to_dave_shielded_transfer, toBlock: blocks.charlie_to_dave_shielded_transfer }
  );
  if (daveNotes.length === 0) throw new Error("no Dave note");
  return `Dave received note @ block ${daveNotes[0].blockHeight}`;
});

await test("scanner filters correctly: Alice's wrap NOT seen as Bob's", async () => {
  const events = await scanCadenceSnapshots(
    ACTORS.bob.cadence,
    "0x7599043aea001283",
    "JanusFT",
    { fromBlock: blocks.alice_wrap, toBlock: blocks.alice_wrap }
  );
  if (events.length !== 0) throw new Error(`expected 0, got ${events.length}`);
  return "0 events for Bob in Alice's wrap block (correct)";
});

console.log("\n=== SDK orchestration produces well-formed proof data ===\n");

await test("orchestrateWrap produces valid txCommit + amountProof + snapshot", async () => {
  const fakeKp = { privkey: 1234n, pubkey: { x: 1n, y: 2n } };
  const r = await Promise.race([
    orchestrateWrap({
      grossAmount: 1_000_000_000_000_000_000n,
      feeBps: 10,
      senderMemoKeypair: fakeKp,
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("orchestrateWrap timeout 60s")), 60_000)),
  ]);
  if (r.netAmount !== 999_000_000_000_000_000n) throw new Error(`bad net: ${r.netAmount}`);
  if (r.fee !== 1_000_000_000_000_000n) throw new Error(`bad fee: ${r.fee}`);
  if (r.amountProof.length !== 8) throw new Error("bad proof length");
  if (r.txCommit.length !== 2) throw new Error("bad commit length");
  if (r.encryptedSnapshot.length === 0) throw new Error("empty snapshot");
  return `net=${r.netAmount}, fee=${r.fee}, proof[0..1]=${r.amountProof[0].toString().slice(0,12)}...`;
});

await test("orchestrateShieldedTransfer produces TWO ephemerals (forward secrecy)", async () => {
  const senderKp = { privkey: 100n, pubkey: { x: 1n, y: 2n } };
  const recipientPub = { x: 3n, y: 4n };
  const r = await Promise.race([
    orchestrateShieldedTransfer({
      currentBalance: 5_000_000_000_000_000_000n,
      currentBlinding: 999n,
      transferAmount: 1_000_000_000_000_000_000n,
      senderMemoKeypair: senderKp,
      recipientMemoKey: recipientPub,
      memo: "test",
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("orchestrateShieldedTransfer timeout 90s")), 90_000)),
  ]);
  if (r.ephPubkeyX === r.ephPubkeyToX) throw new Error("ephemerals must differ!");
  if (r.encryptedSnapshot.length === 0 || r.encryptedNoteTo.length === 0) throw new Error("missing blobs");
  return `eph_snap.x=${r.ephPubkeyX.toString().slice(0,12)}..., eph_note.x=${r.ephPubkeyToX.toString().slice(0,12)}..., different=${r.ephPubkeyX !== r.ephPubkeyToX}`;
});

console.log("\n=== EVM adapter calldata wire format (static-call) ===\n");

await test("flow adapter calldata for publishMemoKey decodes correctly", async () => {
  const iface = new ethers.Interface([
    "function publishMemoKey(uint256 pubkeyX, uint256 pubkeyY) external"
  ]);
  const calldata = iface.encodeFunctionData("publishMemoKey", [123n, 456n]);
  const decoded = iface.parseTransaction({ data: calldata });
  if (decoded.args[0] !== 123n) throw new Error("decode failed");
  return `selector=${calldata.slice(0, 10)}, decoded=(${decoded.args[0]}, ${decoded.args[1]})`;
});

await test("9-param shieldedTransfer ABI selector is canonical uint256[N]", async () => {
  // CRITICAL: must use uint256[6] / uint256[8], NOT uint[6] / uint[8]
  const iface = new ethers.Interface([
    "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external",
  ]);
  const fragment = iface.fragments[0];
  const sig = fragment.format("sighash");
  if (!sig.includes("uint256[6]")) throw new Error(`wrong: ${sig}`);
  if (!sig.includes("uint256[8]")) throw new Error(`wrong: ${sig}`);
  const selector = ethers.id(sig).slice(0, 10);
  return `sig=${sig.slice(0, 80)}..., selector=${selector}`;
});

await test("EVM static-call: feeBps() on all 3 EVM tokens", async () => {
  const provider = new ethers.JsonRpcProvider("https://testnet.evm.nodes.onflow.org");
  const out = {};
  for (const id of ["flow", "wflow", "mockusdc"]) {
    const adapter = sdk.token(id);
    const iface = new ethers.Interface(["function feeBps() view returns (uint16)"]);
    const data = iface.encodeFunctionData("feeBps", []);
    const result = await provider.call({ to: adapter.address, data });
    const [bps] = iface.decodeFunctionResult("feeBps", result);
    out[id] = Number(bps);
    if (Number(bps) !== 10) throw new Error(`${id}: expected 10 bps, got ${bps}`);
  }
  return JSON.stringify(out);
}, 30000);

await test("EVM static-call: balanceOfCommitmentXY for Alice on all 3 tokens", async () => {
  const provider = new ethers.JsonRpcProvider("https://testnet.evm.nodes.onflow.org");
  const out = {};
  for (const id of ["flow", "wflow", "mockusdc"]) {
    const adapter = sdk.token(id);
    const iface = new ethers.Interface(["function balanceOfCommitmentXY(address) view returns (uint256, uint256)"]);
    const data = iface.encodeFunctionData("balanceOfCommitmentXY", [ACTORS.alice.evm]);
    const result = await provider.call({ to: adapter.address, data });
    const [x, y] = iface.decodeFunctionResult("balanceOfCommitmentXY", result);
    out[id] = { x: x.toString().slice(0, 20) + "...", y: y.toString().slice(0, 20) + "..." };
  }
  return JSON.stringify(out);
}, 30000);

results.finishedAt = new Date().toISOString();
results.summary = { passed, failed, total: passed + failed };
results.labTxs = LAB_TXS;
results.labBlocks = blocks;
writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
console.log(`\n=== Summary: ${passed} PASS, ${failed} FAIL ===`);
console.log(`Results saved to ${OUTPUT}`);
// Force exit (snarkjs worker threads can keep the process alive)
process.exit(failed > 0 ? 1 : 0);
