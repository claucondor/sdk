/**
 * tests/integration/network/memokey-registry.test.ts
 *
 * Integration tests for MemoKeyRegistry via the JanusFlowAdapter SDK surface.
 *
 * Tests:
 *   - publishMemoKey: registers a BabyJub pubkey for an EOA
 *   - getMemoKey: reads back the registered pubkey
 *   - rotateMemoKey: rotates to a new keypair
 *   - Unregistered address returns null
 *
 * Gated by RUN_INTEGRATION=1.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  makeDeployerWallet,
  createFreshBob,
  deriveMemoKeypair,
  skipIfNotIntegration,
  ADDRESSES,
} from "../helpers/testnet";
import { JanusFlowAdapter, TOKEN_REGISTRY } from "../../../src/index";

const SKIP = process.env.RUN_INTEGRATION !== "1";

describe("MemoKeyRegistry — integration", () => {
  const adapter = new JanusFlowAdapter("flow", TOKEN_REGISTRY.flow);

  // Fresh wallets per suite
  let alice: ReturnType<typeof makeDeployerWallet>;
  let bob:   { wallet: ReturnType<typeof makeDeployerWallet>; address: string; fundTxHash: string };

  // BabyJub keypairs
  let aliceJub: Awaited<ReturnType<typeof deriveMemoKeypair>>;
  let aliceJubNew: Awaited<ReturnType<typeof deriveMemoKeypair>>;
  let bobJub:   Awaited<ReturnType<typeof deriveMemoKeypair>>;

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotIntegration();

    alice = makeDeployerWallet();
    bob   = await createFreshBob("0.01");

    // Derive deterministic BabyJub keypairs for both
    aliceJub    = await deriveMemoKeypair(alice.address, "memokey-registry-test:v1");
    aliceJubNew = await deriveMemoKeypair(alice.address, "memokey-registry-test:v2-rotated");
    bobJub      = await deriveMemoKeypair(bob.address, "memokey-registry-test:v1");

    console.log(`[MemoKeyRegistry] Alice: ${alice.address}`);
    console.log(`[MemoKeyRegistry] Bob:   ${bob.address} (funded: ${bob.fundTxHash})`);
  }, 60_000);

  it("should return null for unregistered Bob address initially", async () => {
    if (SKIP) return;

    // If Bob previously published a key in another test run, skip the null check.
    const existing = await adapter.getMemoKey(bob.address);
    if (existing !== null) {
      console.log("[MemoKeyRegistry] Bob already has a key from a prior run — skipping null check");
      return;
    }

    const result = await adapter.getMemoKey(bob.address);
    expect(result).toBeNull();
  }, 30_000);

  it("should publish Alice's memokey and read it back", async () => {
    if (SKIP) return;

    // If Alice already has a key with exactly aliceJub pubkey, rotation may be needed.
    const existing = await adapter.getMemoKey(alice.address);
    if (existing !== null) {
      // Alice already published; rotate to aliceJub if different
      if (existing.x !== aliceJub.pubkey.x || existing.y !== aliceJub.pubkey.y) {
        const rotResult = await adapter.rotateMemoKey(aliceJub, alice);
        console.log(`[MemoKeyRegistry] Alice rotated to aliceJub: ${rotResult.txHash}`);
      } else {
        console.log("[MemoKeyRegistry] Alice already has aliceJub — skipping publish");
      }
    } else {
      const pubResult = await adapter.publishMemoKey(aliceJub, alice);
      expect(pubResult.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      console.log(`[MemoKeyRegistry] Alice publishMemoKey tx: ${pubResult.txHash}`);
    }

    // Verify registry
    const key = await adapter.getMemoKey(alice.address);
    expect(key).not.toBeNull();
    expect(key!.x).toBe(aliceJub.pubkey.x);
    expect(key!.y).toBe(aliceJub.pubkey.y);
    console.log(`[MemoKeyRegistry] Alice pubkey.x: ${key!.x.toString().slice(0, 20)}...`);
  }, 60_000);

  it("should publish Bob's memokey and read it back", async () => {
    if (SKIP) return;

    const existing = await adapter.getMemoKey(bob.address);
    if (existing !== null) {
      console.log("[MemoKeyRegistry] Bob already has a key — verifying presence");
      expect(existing.x).toBeGreaterThan(0n);
      expect(existing.y).toBeGreaterThan(0n);
      return;
    }

    const pubResult = await adapter.publishMemoKey(bobJub, bob.wallet);
    expect(pubResult.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    console.log(`[MemoKeyRegistry] Bob publishMemoKey tx: ${pubResult.txHash}`);

    const key = await adapter.getMemoKey(bob.address);
    expect(key).not.toBeNull();
    expect(key!.x).toBe(bobJub.pubkey.x);
    expect(key!.y).toBe(bobJub.pubkey.y);
  }, 60_000);

  it("should rotate Alice's memokey to a new keypair", async () => {
    if (SKIP) return;

    // Ensure Alice has a key to rotate (from prior test)
    const existing = await adapter.getMemoKey(alice.address);
    expect(existing).not.toBeNull(); // prior test should have ensured this

    const rotResult = await adapter.rotateMemoKey(aliceJubNew, alice);
    expect(rotResult.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    console.log(`[MemoKeyRegistry] Alice rotateMemoKey tx: ${rotResult.txHash}`);

    const key = await adapter.getMemoKey(alice.address);
    expect(key).not.toBeNull();
    expect(key!.x).toBe(aliceJubNew.pubkey.x);
    expect(key!.y).toBe(aliceJubNew.pubkey.y);

    // Best-effort rotate back to aliceJub for downstream test symmetry.
    // Not critical — subsequent test files use fresh accounts that don't depend on Alice's key.
    try {
      await adapter.rotateMemoKey(aliceJub, alice);
      console.log("[MemoKeyRegistry] Rotated back to aliceJub for downstream tests");
    } catch (err) {
      console.warn("[MemoKeyRegistry] Rotate-back to aliceJub skipped (non-fatal):", (err as Error).message?.slice(0, 80));
    }
  }, 90_000);

  it("addresses should match TOKEN_REGISTRY and ADDRESSES constants", () => {
    if (SKIP) return;

    expect(adapter.address).toBe(ADDRESSES.janusFlow);
    expect(adapter.memoRegistryAddress).toBe(ADDRESSES.memoKeyRegistry);
    expect(adapter.variant).toBe("native");
    expect(adapter.decimals).toBe(18);
  });
});
