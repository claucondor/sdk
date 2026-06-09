/**
 * tests/integration/inbox/shielded-inbox-client.test.ts
 *
 * Integration tests for ShieldedInboxClient against deployed v0.8 testnet.
 *
 * Tests (in order):
 *   1. count: Bob starts with 0 pending notes
 *   2. peek: no notes to peek at
 *   3. Alice wraps FLOW + shieldedTransfers to Bob (seeds Bob's inbox)
 *   4. count: Bob has 1 note
 *   5. peek: non-consuming read works
 *   6. drainBatch: drains 1 note, returns Note struct
 *   7. count: Bob has 0 notes after drain
 *   8. drainAndDecrypt: wrap + transfer again, then drain + decrypt in one call
 *
 * Gated by RUN_INTEGRATION=1.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { ethers } from "ethers";
import {
  makeDeployerWallet,
  createFreshBob,
  deriveMemoKeypair,
  skipIfNotIntegration,
  ADDRESSES,
  JANUS_FLOW_ABI,
  TINY_FLOW,
  splitProofForEvm,
} from "../helpers/testnet";
import {
  ShieldedInboxClient,
  JanusFlowAdapter,
  TOKEN_REGISTRY,
  orchestrateWrap,
  orchestrateShieldedTransfer,
} from "../../../src/index";

const SKIP = process.env.RUN_INTEGRATION !== "1";

describe("ShieldedInboxClient — integration", () => {
  const inboxClient = new ShieldedInboxClient();
  const adapter     = new JanusFlowAdapter("flow", TOKEN_REGISTRY.flow);

  let alice: ReturnType<typeof makeDeployerWallet>;
  let bob:   Awaited<ReturnType<typeof createFreshBob>>;

  let aliceJub: Awaited<ReturnType<typeof deriveMemoKeypair>>;
  let bobJub:   Awaited<ReturnType<typeof deriveMemoKeypair>>;

  // Shared state: Alice's balance after each wrap
  let aliceBalance: bigint;
  let aliceBlinding: bigint;

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotIntegration();

    alice = makeDeployerWallet();
    bob   = await createFreshBob("0.01");

    aliceJub = await deriveMemoKeypair(alice.address, "inbox-test:alice");
    bobJub   = await deriveMemoKeypair(bob.address,   "inbox-test:bob");

    // Ensure both memokeys are registered
    const aliceKey = await adapter.getMemoKey(alice.address);
    if (!aliceKey || aliceKey.x !== aliceJub.pubkey.x) {
      if (!aliceKey) {
        await adapter.publishMemoKey(aliceJub, alice);
      } else {
        await adapter.rotateMemoKey(aliceJub, alice);
      }
    }

    const bobKey = await adapter.getMemoKey(bob.address);
    if (!bobKey) {
      await adapter.publishMemoKey(bobJub, bob.wallet);
    }

    console.log(`[Inbox] Alice: ${alice.address}`);
    console.log(`[Inbox] Bob:   ${bob.address}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 1 — Drain Bob's inbox to start fresh (if dirty from prior run)
  // ---------------------------------------------------------------------------

  it("should drain any leftover notes to start clean", async () => {
    if (SKIP) return;

    const count = await inboxClient.count(bob.address);
    if (count > 0n) {
      console.log(`[Inbox] Bob has ${count} leftover notes — draining`);
      const { txHash } = await inboxClient.drainAll(bob.wallet);
      expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }

    const after = await inboxClient.count(bob.address);
    expect(after).toBe(0n);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Step 2 — count + peek with empty inbox
  // ---------------------------------------------------------------------------

  it("count should return 0 for empty inbox", async () => {
    if (SKIP) return;

    const count = await inboxClient.count(bob.address);
    expect(count).toBe(0n);
  }, 30_000);

  it("peek on empty inbox should return empty array", async () => {
    if (SKIP) return;

    const notes = await inboxClient.peekAll(bob.address);
    expect(notes).toHaveLength(0);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Step 3 — Alice wraps + sends to Bob
  // ---------------------------------------------------------------------------

  it("should seed Bob's inbox via Alice wrap + shieldedTransfer", async () => {
    if (SKIP) return;

    // Use orchestrateWrap to capture blinding (needed for subsequent transfer)
    const feeBps = await adapter.feeBps();
    const orchWrap = await orchestrateWrap({
      grossAmount:      TINY_FLOW,
      feeBps,
      senderMemoKeypair: { privkey: 0n, pubkey: aliceJub.pubkey },
    });

    // Submit wrap via direct ethers (integration tests may use ethers.Contract)
    const janusFlow = new ethers.Contract(
      ADDRESSES.janusFlow,
      JANUS_FLOW_ABI,
      alice
    );
    const { pA, pB, pC } = splitProofForEvm(orchWrap.amountProof);
    const wrapTx = await janusFlow.wrapWithProof(
      orchWrap.nonce,
      [orchWrap.txCommit[0], orchWrap.txCommit[1]],
      pA, pB, pC,
      ethers.hexlify(orchWrap.encryptedSnapshot),
      orchWrap.ephPubkeyX,
      orchWrap.ephPubkeyY,
      { value: TINY_FLOW }
    );
    await wrapTx.wait(1);
    console.log(`[Inbox] Alice wrap tx: ${wrapTx.hash}`);

    aliceBalance  = orchWrap.netAmount;
    aliceBlinding = orchWrap.blinding;

    // Transfer to Bob
    const transferAmount = aliceBalance / 2n; // 50% of wrapped amount
    const bobCountBefore = await inboxClient.count(bob.address);

    const orchXfer = await orchestrateShieldedTransfer({
      currentBalance:    aliceBalance,
      currentBlinding:   aliceBlinding,
      transferAmount,
      senderMemoKeypair: { privkey: 0n, pubkey: aliceJub.pubkey },
      recipientMemoKey:  bobJub.pubkey,
      memo:              "inbox integration test",
    });

    const xferTx = await janusFlow.shieldedTransfer(
      bob.address,
      [...orchXfer.txParams.publicInputs],
      [...orchXfer.txParams.proof],
      ethers.hexlify(orchXfer.txParams.encryptedNoteTo),
      orchXfer.txParams.ephPubkeyToX,
      orchXfer.txParams.ephPubkeyToY
    );
    await xferTx.wait(1);
    console.log(`[Inbox] Alice shieldedTransfer tx: ${xferTx.hash}`);

    // Update Alice's state
    aliceBalance  = orchXfer.newBalance;
    aliceBlinding = orchXfer.newBlinding;

    // Verify Bob's inbox count increased
    const bobCountAfter = await inboxClient.count(bob.address);
    expect(bobCountAfter).toBe(bobCountBefore + 1n);
    console.log(`[Inbox] Bob inbox count: ${bobCountBefore} → ${bobCountAfter}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 4 — count with note in inbox
  // ---------------------------------------------------------------------------

  it("count should return 1 after transfer", async () => {
    if (SKIP) return;

    const count = await inboxClient.count(bob.address);
    expect(count).toBeGreaterThanOrEqual(1n);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Step 5 — peek (non-consuming)
  // ---------------------------------------------------------------------------

  it("peek should return notes without consuming them", async () => {
    if (SKIP) return;

    const countBefore = await inboxClient.count(bob.address);
    const notes = await inboxClient.peek(bob.address, 0n, 1n);

    expect(notes.length).toBeGreaterThanOrEqual(1);
    const note = notes[0];
    expect(note.ciphertext).toBeInstanceOf(Uint8Array);
    expect(note.ciphertext.length).toBeGreaterThan(0);
    expect(note.ephPubkeyX).toBeGreaterThan(0n);
    expect(note.ephPubkeyY).toBeGreaterThan(0n);
    expect(note.depositor.toLowerCase()).toBe(ADDRESSES.janusFlow.toLowerCase());
    expect(note.blockNumber).toBeGreaterThan(0n);

    // Confirm inbox was NOT consumed
    const countAfter = await inboxClient.count(bob.address);
    expect(countAfter).toBe(countBefore);
    console.log(`[Inbox] peek: got ${notes.length} note(s), inbox count unchanged at ${countAfter}`);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Step 6 — drainBatch
  // ---------------------------------------------------------------------------

  it("drainBatch should drain notes and return them", async () => {
    if (SKIP) return;

    const countBefore = await inboxClient.count(bob.address);
    expect(countBefore).toBeGreaterThan(0n);

    const { notes, txHash } = await inboxClient.drainBatch(1n, bob.wallet);

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(notes.length).toBeGreaterThanOrEqual(1);
    console.log(`[Inbox] drainBatch tx: ${txHash}, notes: ${notes.length}`);

    const note = notes[0];
    expect(note.ciphertext).toBeInstanceOf(Uint8Array);
    expect(note.ephPubkeyX).toBeGreaterThan(0n);
    expect(note.ephPubkeyY).toBeGreaterThan(0n);
    expect(note.depositor.toLowerCase()).toBe(ADDRESSES.janusFlow.toLowerCase());
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Step 7 — count after drain
  // ---------------------------------------------------------------------------

  it("count should be 0 after drainBatch", async () => {
    if (SKIP) return;

    const count = await inboxClient.count(bob.address);
    expect(count).toBe(0n);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Step 8 — drainAndDecrypt
  // ---------------------------------------------------------------------------

  it("drainAndDecrypt should drain and ECIES-decode notes", async () => {
    if (SKIP) return;

    // Send another note from Alice
    const janusFlow = new ethers.Contract(
      ADDRESSES.janusFlow,
      JANUS_FLOW_ABI,
      alice
    );

    // Alice has remaining balance from previous transfer
    if (aliceBalance === 0n) {
      console.log("[Inbox] Alice balance is 0, wrapping fresh 0.02 FLOW");
      const feeBps = await adapter.feeBps();
      const orchWrap = await orchestrateWrap({
        grossAmount:      TINY_FLOW,
        feeBps,
        senderMemoKeypair: { privkey: 0n, pubkey: aliceJub.pubkey },
      });
      const { pA, pB, pC } = splitProofForEvm(orchWrap.amountProof);
      const wrapTx = await janusFlow.wrapWithProof(
        orchWrap.nonce,
        [orchWrap.txCommit[0], orchWrap.txCommit[1]],
        pA, pB, pC,
        ethers.hexlify(orchWrap.encryptedSnapshot),
        orchWrap.ephPubkeyX,
        orchWrap.ephPubkeyY,
        { value: TINY_FLOW }
      );
      await wrapTx.wait(1);
      aliceBalance  = orchWrap.netAmount;
      aliceBlinding = orchWrap.blinding;
    }

    const transferAmount = aliceBalance > 10n ? aliceBalance / 5n : aliceBalance;
    const memo = "drain-and-decrypt test";

    const orchXfer = await orchestrateShieldedTransfer({
      currentBalance:    aliceBalance,
      currentBlinding:   aliceBlinding,
      transferAmount,
      senderMemoKeypair: { privkey: 0n, pubkey: aliceJub.pubkey },
      recipientMemoKey:  bobJub.pubkey,
      memo,
    });
    const xferTx = await janusFlow.shieldedTransfer(
      bob.address,
      [...orchXfer.txParams.publicInputs],
      [...orchXfer.txParams.proof],
      ethers.hexlify(orchXfer.txParams.encryptedNoteTo),
      orchXfer.txParams.ephPubkeyToX,
      orchXfer.txParams.ephPubkeyToY
    );
    await xferTx.wait(1);
    console.log(`[Inbox] Second transfer tx: ${xferTx.hash}`);

    aliceBalance  = orchXfer.newBalance;
    aliceBlinding = orchXfer.newBlinding;

    // Drain and decrypt using Bob's BabyJub private key
    const { notes, decrypted, failed, txHash } =
      await inboxClient.drainAndDecrypt(bob.wallet, bobJub.privkey);

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(notes.length).toBeGreaterThan(0);
    expect(decrypted.length).toBeGreaterThan(0);
    expect(failed.length).toBe(0); // All notes should decrypt for Bob

    const decoded = decrypted[0].content;
    expect(decoded.amount).toBe(transferAmount);
    expect(decoded.memo).toBe(memo);
    console.log(`[Inbox] drainAndDecrypt tx: ${txHash}, decoded amount: ${decoded.amount}, memo: "${decoded.memo}"`);
  }, 180_000);
});
