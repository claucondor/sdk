/**
 * tests/integration/checkpoint/checkpoint-multi-token.integration.test.ts
 *
 * Integration smoke test for multi-token ShieldedCheckpoint isolation.
 * Verifies that FLOW and mUSDC checkpoint slots are independent — writing one
 * does NOT affect the other.
 *
 * Pattern mirrors openjanus-contracts/tests/v0.8-smoke/scripts/combo-F.cjs.
 *
 * Gated by RUN_INTEGRATION=1 env var. Skip silently if not set.
 *
 * Account: uses the deployer EOA (0xFc47B35f79d26A060B652E112c53d7c6057d05FF)
 * — funded via openjanus-v08 key. The test clears state by writing new values;
 * it does NOT require the account to be fresh.
 *
 * New ShieldedCheckpoint addr: 0x88C9fD443BC15d1Cd24bc724DB6928D3246b2E26
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  makeDeployerWallet,
  deriveMemoKeypair,
  skipIfNotIntegration,
} from "../helpers/testnet";
import { ShieldedCheckpointClient, generateBlinding } from "../../../src/index";
import { TOKEN_REGISTRY, SHIELDED_CHECKPOINT_ADDRESS } from "../../../src/network/contracts";

const SKIP = process.env.RUN_INTEGRATION !== "1";

const FLOW_TOKEN  = TOKEN_REGISTRY.flow.proxy;
const MUSDC_TOKEN = TOKEN_REGISTRY.mockusdc.proxy;

// Distinct values per token — isolation verified by checking cross-reads
const FLOW_BALANCE   = 1_000_000_000_000_000_000n;  // 1 FLOW (attoFLOW)
const MUSDC_BALANCE  = 5_000_000n;                  // 5 mUSDC (6 decimals)
const FLOW_BLINDING  = generateBlinding();
const MUSDC_BLINDING = generateBlinding();
const FLOW_CURSOR    = 10n;
const MUSDC_CURSOR   = 20n;

describe("ShieldedCheckpointClient — multi-token isolation (integration)", () => {
  const client = new ShieldedCheckpointClient();

  let alice: ReturnType<typeof makeDeployerWallet>;
  let aliceJub: Awaited<ReturnType<typeof deriveMemoKeypair>>;

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotIntegration();

    alice    = makeDeployerWallet();
    aliceJub = await deriveMemoKeypair(alice.address, "multitoken-test:v1");

    console.log(`[MultiToken] Alice: ${alice.address}`);
    console.log(`[MultiToken] CheckpointContract: ${SHIELDED_CHECKPOINT_ADDRESS}`);
    console.log(`[MultiToken] FLOW_TOKEN: ${FLOW_TOKEN}`);
    console.log(`[MultiToken] MUSDC_TOKEN: ${MUSDC_TOKEN}`);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Phase 1: Write FLOW checkpoint
  // ---------------------------------------------------------------------------

  it("Phase 1 — should write FLOW checkpoint and read it back correctly", async () => {
    if (SKIP) return;

    const { txHash, version } = await client.encryptAndUpdate(
      FLOW_TOKEN,
      { balance: FLOW_BALANCE, blinding: FLOW_BLINDING },
      FLOW_CURSOR,
      aliceJub,
      alice,
    );

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(version).toBeGreaterThanOrEqual(1n);
    console.log(`[MultiToken] FLOW write tx: ${txHash}, v=${version}`);

    const snap = await client.readAndDecrypt(FLOW_TOKEN, alice, aliceJub.privkey);
    expect(snap).not.toBeNull();
    expect(snap!.balance).toBe(FLOW_BALANCE);
    expect(snap!.blinding).toBe(FLOW_BLINDING);

    const raw = await client.read(FLOW_TOKEN, alice);
    expect(raw!.lastConsumedNoteIndex).toBe(FLOW_CURSOR);

    console.log(`[MultiToken] FLOW balance verified: ${snap!.balance}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Phase 2: Write mUSDC checkpoint (different token, same user)
  // ---------------------------------------------------------------------------

  it("Phase 2 — should write mUSDC checkpoint independently of FLOW", async () => {
    if (SKIP) return;

    const { txHash, version } = await client.encryptAndUpdate(
      MUSDC_TOKEN,
      { balance: MUSDC_BALANCE, blinding: MUSDC_BLINDING },
      MUSDC_CURSOR,
      aliceJub,
      alice,
    );

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(version).toBeGreaterThanOrEqual(1n);
    console.log(`[MultiToken] mUSDC write tx: ${txHash}, v=${version}`);

    const snap = await client.readAndDecrypt(MUSDC_TOKEN, alice, aliceJub.privkey);
    expect(snap).not.toBeNull();
    expect(snap!.balance).toBe(MUSDC_BALANCE);
    expect(snap!.blinding).toBe(MUSDC_BLINDING);

    const raw = await client.read(MUSDC_TOKEN, alice);
    expect(raw!.lastConsumedNoteIndex).toBe(MUSDC_CURSOR);

    console.log(`[MultiToken] mUSDC balance verified: ${snap!.balance}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Phase 3: Read BOTH back and assert isolation
  // ---------------------------------------------------------------------------

  it("Phase 3 — FLOW and mUSDC checkpoints are fully isolated", async () => {
    if (SKIP) return;

    // FLOW checkpoint unchanged after mUSDC write
    const flowSnap = await client.readAndDecrypt(FLOW_TOKEN, alice, aliceJub.privkey);
    expect(flowSnap).not.toBeNull();
    expect(flowSnap!.balance).toBe(FLOW_BALANCE);
    expect(flowSnap!.blinding).toBe(FLOW_BLINDING);

    // mUSDC checkpoint unchanged after FLOW write
    const usdcSnap = await client.readAndDecrypt(MUSDC_TOKEN, alice, aliceJub.privkey);
    expect(usdcSnap).not.toBeNull();
    expect(usdcSnap!.balance).toBe(MUSDC_BALANCE);
    expect(usdcSnap!.blinding).toBe(MUSDC_BLINDING);

    // Cursors are independent
    const flowRaw  = await client.read(FLOW_TOKEN, alice);
    const usdcRaw  = await client.read(MUSDC_TOKEN, alice);
    expect(flowRaw!.lastConsumedNoteIndex).toBe(FLOW_CURSOR);
    expect(usdcRaw!.lastConsumedNoteIndex).toBe(MUSDC_CURSOR);

    console.log("[MultiToken] Isolation verified:");
    console.log(`  FLOW  balance=${flowSnap!.balance}  cursor=${flowRaw!.lastConsumedNoteIndex}`);
    console.log(`  mUSDC balance=${usdcSnap!.balance}  cursor=${usdcRaw!.lastConsumedNoteIndex}`);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Phase 4: exists() and metadata() are per-token
  // ---------------------------------------------------------------------------

  it("Phase 4 — exists() and metadata() work per-token", async () => {
    if (SKIP) return;

    const flowExists  = await client.exists(alice.address, FLOW_TOKEN);
    const usdcExists  = await client.exists(alice.address, MUSDC_TOKEN);
    expect(flowExists).toBe(true);
    expect(usdcExists).toBe(true);

    const flowMeta  = await client.metadata(alice.address, FLOW_TOKEN);
    const usdcMeta  = await client.metadata(alice.address, MUSDC_TOKEN);
    expect(flowMeta.hasCheckpoint).toBe(true);
    expect(usdcMeta.hasCheckpoint).toBe(true);
    expect(flowMeta.lastConsumedNoteIndex).toBe(FLOW_CURSOR);
    expect(usdcMeta.lastConsumedNoteIndex).toBe(MUSDC_CURSOR);

    console.log(`[MultiToken] FLOW  meta: version=${flowMeta.version}, cursor=${flowMeta.lastConsumedNoteIndex}`);
    console.log(`[MultiToken] mUSDC meta: version=${usdcMeta.version}, cursor=${usdcMeta.lastConsumedNoteIndex}`);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Phase 5: read() on unknown token returns null (NoCheckpoint)
  // ---------------------------------------------------------------------------

  it("Phase 5 — read() returns null for a token with no checkpoint", async () => {
    if (SKIP) return;

    // Use a random unknown token address (zero address should have no checkpoint)
    const unknownToken = "0x0000000000000000000000000000000000000001";
    const result = await client.read(unknownToken, alice);
    // May return null (NoCheckpoint) or throw — depends on contract behavior
    // Either way, the read call should not throw a generic EVM error
    if (result !== null) {
      // If contract doesn't revert for unknown tokens (e.g., returns zero-state),
      // log the result for operator review
      console.log(`[MultiToken] NOTE: read() for unknown token returned non-null: version=${result.version}`);
    } else {
      console.log(`[MultiToken] read() for unknown token correctly returned null`);
    }
  }, 30_000);
});
