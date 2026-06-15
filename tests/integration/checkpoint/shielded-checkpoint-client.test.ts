/**
 * tests/integration/checkpoint/shielded-checkpoint-client.test.ts
 *
 * Integration tests for ShieldedCheckpointClient against deployed v0.8.2 testnet.
 *
 * v0.8.2 BREAKING CHANGE: all methods take `token` as first arg.
 * Tests use TOKEN_REGISTRY.flow.proxy as the token address.
 *
 * Tests (in order):
 *   1. encryptAndUpdate → read → readAndDecrypt: snapshot round-trip (per-token)
 *   2. metadata (public): returns expected fields after update
 *   3. cursor monotonicity NOT enforced: can rewind lastConsumedNoteIndex
 *   4. snapshot too large (> MAX_SNAPSHOT_BYTES=16384) reverts SnapshotTooLarge
 *   5. exists() check per-token
 *   6. address constant matches new v0.8.2 deployment
 *
 * Gated by RUN_INTEGRATION=1.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  makeDeployerWallet,
  deriveMemoKeypair,
  skipIfNotIntegration,
  ADDRESSES,
} from "../helpers/testnet";
import {
  ShieldedCheckpointClient,
  generateBlinding,
} from "../../../src/index";
import { TOKEN_REGISTRY } from "../../../src/network/contracts";

const SKIP = process.env.RUN_INTEGRATION !== "1";

// Token address used throughout — JanusFlow proxy
const FLOW_TOKEN = TOKEN_REGISTRY.flow.proxy;

describe("ShieldedCheckpointClient — integration (v0.8.2 per-token)", () => {
  const checkpointClient = new ShieldedCheckpointClient();

  let alice: ReturnType<typeof makeDeployerWallet>;
  let aliceJub: Awaited<ReturnType<typeof deriveMemoKeypair>>;

  // Snapshot values written in test 1 — read back in subsequent tests
  const SNAPSHOT_BALANCE  = 987_654_321_000_000_000n; // ~0.987 FLOW in attoFLOW
  const SNAPSHOT_BLINDING = generateBlinding();
  const CURSOR_INITIAL    = 5n;

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotIntegration();

    alice    = makeDeployerWallet();
    aliceJub = await deriveMemoKeypair(alice.address, "checkpoint-test:alice:v2");

    console.log(`[Checkpoint] Alice: ${alice.address}`);
    console.log(`[Checkpoint] Contract: ${ADDRESSES.shieldedCheckpoint}`);
    console.log(`[Checkpoint] Token (FLOW proxy): ${FLOW_TOKEN}`);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Test 1 — encryptAndUpdate → read → readAndDecrypt (snapshot round-trip)
  // ---------------------------------------------------------------------------

  it("should write encrypted snapshot for FLOW token and read it back decrypted", async () => {
    if (SKIP) return;

    // Write checkpoint at cursor CURSOR_INITIAL for FLOW token
    const { txHash, version } = await checkpointClient.encryptAndUpdate(
      FLOW_TOKEN,
      { balance: SNAPSHOT_BALANCE, blinding: SNAPSHOT_BLINDING },
      CURSOR_INITIAL,
      aliceJub,
      alice,
    );

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(version).toBeGreaterThanOrEqual(1n);
    console.log(`[Checkpoint] encryptAndUpdate tx: ${txHash}, version: ${version}`);

    // Read raw checkpoint (owner-only) for FLOW token
    const raw = await checkpointClient.read(FLOW_TOKEN, alice);
    expect(raw).not.toBeNull();
    expect(raw!.encryptedSnapshot.length).toBeGreaterThan(0);
    expect(raw!.ephPubkeyX).toBeGreaterThan(0n);
    expect(raw!.ephPubkeyY).toBeGreaterThan(0n);
    expect(raw!.lastConsumedNoteIndex).toBe(CURSOR_INITIAL);
    expect(raw!.version).toBeGreaterThanOrEqual(1n);
    console.log(
      `[Checkpoint] raw.lastConsumedNoteIndex: ${raw!.lastConsumedNoteIndex}, ` +
      `raw.version: ${raw!.version}`
    );

    // Decrypt and verify snapshot content
    const snap = await checkpointClient.readAndDecrypt(FLOW_TOKEN, alice, aliceJub.privkey);
    expect(snap).not.toBeNull();
    expect(snap!.balance).toBe(SNAPSHOT_BALANCE);
    expect(snap!.blinding).toBe(SNAPSHOT_BLINDING);
    console.log(`[Checkpoint] decrypted balance: ${snap!.balance}, blinding: ${snap!.blinding.toString().slice(0,20)}...`);
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Test 2 — metadata (public) returns expected fields
  // ---------------------------------------------------------------------------

  it("metadata should return hasCheckpoint=true with correct cursor after update", async () => {
    if (SKIP) return;

    const meta = await checkpointClient.metadata(alice.address, FLOW_TOKEN);
    expect(meta.hasCheckpoint).toBe(true);
    expect(meta.version).toBeGreaterThanOrEqual(1n);
    expect(meta.lastConsumedNoteIndex).toBeGreaterThanOrEqual(0n);
    expect(meta.lastUpdatedBlock).toBeGreaterThan(0n);
    console.log(
      `[Checkpoint] metadata: version=${meta.version}, ` +
      `cursor=${meta.lastConsumedNoteIndex}, block=${meta.lastUpdatedBlock}`
    );
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Test 3 — cursor monotonicity NOT enforced (can rewind)
  // ---------------------------------------------------------------------------

  it("should allow cursor rewind (no monotonicity enforcement on-chain)", async () => {
    if (SKIP) return;

    // Write at a high cursor
    const highCursor = 42n;
    const { txHash: tx1, version: v1 } = await checkpointClient.encryptAndUpdate(
      FLOW_TOKEN,
      { balance: 111_000_000_000_000_000n, blinding: generateBlinding() },
      highCursor,
      aliceJub,
      alice,
    );
    expect(tx1).toMatch(/^0x[0-9a-fA-F]{64}$/);
    console.log(`[Checkpoint] cursor=42 tx: ${tx1}, v=${v1}`);

    // Rewind to lower cursor — should succeed (no revert)
    const lowCursor = 3n;
    const { txHash: tx2, version: v2 } = await checkpointClient.encryptAndUpdate(
      FLOW_TOKEN,
      { balance: 222_000_000_000_000_000n, blinding: generateBlinding() },
      lowCursor,
      aliceJub,
      alice,
    );
    expect(tx2).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(v2).toBeGreaterThan(v1); // version increments on every update
    console.log(`[Checkpoint] rewind cursor=3 tx: ${tx2}, v=${v2}`);

    const raw = await checkpointClient.read(FLOW_TOKEN, alice);
    expect(raw).not.toBeNull();
    expect(raw!.lastConsumedNoteIndex).toBe(lowCursor);
    console.log(`[Checkpoint] after rewind, cursor=${raw!.lastConsumedNoteIndex} (was 42)`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Test 4 — snapshot too large reverts SnapshotTooLarge
  // ---------------------------------------------------------------------------

  it("should revert with SnapshotTooLarge for snapshots > 16384 bytes", async () => {
    if (SKIP) return;

    // Build a 16385-byte snapshot (1 byte over MAX_SNAPSHOT_BYTES=16384)
    const oversizedSnapshot = new Uint8Array(16385).fill(0xab);
    const fakeEphX = 1n;
    const fakeEphY = 2n;

    // Call update() directly (bypassing encryptAndUpdate) with the oversized blob
    await expect(
      checkpointClient.update(
        FLOW_TOKEN,
        {
          encryptedSnapshot: oversizedSnapshot,
          ephPubkeyX: fakeEphX,
          ephPubkeyY: fakeEphY,
        },
        0n,
        alice,
      )
    ).rejects.toThrow();

    console.log(`[Checkpoint] SnapshotTooLarge correctly reverted for 16385-byte snapshot`);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Test 5 — exists() check per-token
  // ---------------------------------------------------------------------------

  it("exists() should return true for Alice/FLOW after updates", async () => {
    if (SKIP) return;

    const doesExist = await checkpointClient.exists(alice.address, FLOW_TOKEN);
    expect(doesExist).toBe(true);
    console.log(`[Checkpoint] exists(alice, FLOW_TOKEN)=${doesExist}`);
  }, 15_000);

  // ---------------------------------------------------------------------------
  // Test 6 — address constant matches expected deployed address (v0.8.2)
  // ---------------------------------------------------------------------------

  it("contract address should match new SHIELDED_CHECKPOINT_ADDRESS (v0.8.2)", () => {
    if (SKIP) return;

    expect(checkpointClient.address.toLowerCase()).toBe(
      ADDRESSES.shieldedCheckpoint.toLowerCase()
    );
    // Explicitly verify the new v0.8.2 address
    expect(checkpointClient.address.toLowerCase()).toBe(
      "0x88c9fd443bc15d1cd24bc724db6928d3246b2e26"
    );
  });
});
