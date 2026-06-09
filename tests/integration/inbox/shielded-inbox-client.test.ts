/**
 * tests/integration/inbox/shielded-inbox-client.test.ts
 *
 * Integration tests for ShieldedInboxClient against deployed v0.8 testnet.
 *
 * Uses FRESH sender + Bob accounts to avoid C_old mismatch from prior test runs
 * that may have left stale commitment state on the deployer address.
 * The deployer (Alice) only funds fresh accounts.
 *
 * Tests (in order):
 *   1. Drain Bob's inbox to start clean
 *   2. count: Bob starts with 0 pending notes
 *   3. peek: no notes to peek at
 *   4. Sender wraps FLOW + shieldedTransfers to Bob (seeds Bob's inbox)
 *   5. count: Bob has 1 note
 *   6. peek: non-consuming read works
 *   7. drainBatch: drains 1 note, returns Note struct
 *   8. count: Bob has 0 notes after drain
 *   9. drainAndDecrypt: transfer again, then drain + decrypt in one call
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
  MICRO_FLOW,
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

  // Use fresh sender (not deployer) to avoid C_old mismatch with prior runs
  let sender: Awaited<ReturnType<typeof createFreshBob>>;
  let bob:    Awaited<ReturnType<typeof createFreshBob>>;

  let senderJub: Awaited<ReturnType<typeof deriveMemoKeypair>>;
  let bobJub:    Awaited<ReturnType<typeof deriveMemoKeypair>>;

  // Shared state: sender's balance after each wrap
  let senderBalance:  bigint;
  let senderBlinding: bigint;

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotIntegration();

    // Fresh accounts — deployer funds them
    sender = await createFreshBob("0.07"); // enough for gas (0.04) + wrap (0.02)
    bob    = await createFreshBob("0.005");

    senderJub = await deriveMemoKeypair(sender.address, "inbox-test:sender");
    bobJub    = await deriveMemoKeypair(bob.address,    "inbox-test:bob");

    // Ensure both memokeys are registered
    const senderKey = await adapter.getMemoKey(sender.address);
    if (!senderKey) {
      await adapter.publishMemoKey(senderJub, sender.wallet);
    } else if (senderKey.x !== senderJub.pubkey.x || senderKey.y !== senderJub.pubkey.y) {
      await adapter.rotateMemoKey(senderJub, sender.wallet);
    }

    const bobKey = await adapter.getMemoKey(bob.address);
    if (!bobKey) {
      await adapter.publishMemoKey(bobJub, bob.wallet);
    }

    console.log(`[Inbox] Sender: ${sender.address} (funded: ${sender.fundTxHash})`);
    console.log(`[Inbox] Bob:    ${bob.address}`);
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
  // Step 3 — Sender wraps + sends to Bob (fresh sender, clean slot)
  // ---------------------------------------------------------------------------

  it("should seed Bob's inbox via sender wrap + shieldedTransfer", async () => {
    if (SKIP) return;

    // Use orchestrateWrap to capture blinding (needed for subsequent transfer)
    const feeBps   = await adapter.feeBps();
    const orchWrap = await orchestrateWrap({
      grossAmount:       TINY_FLOW,
      feeBps,
      senderMemoKeypair: { privkey: 0n, pubkey: senderJub.pubkey },
    });

    const janusFlow = new ethers.Contract(ADDRESSES.janusFlow, JANUS_FLOW_ABI, sender.wallet);
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
    console.log(`[Inbox] Sender wrap tx: ${wrapTx.hash}`);

    senderBalance  = orchWrap.netAmount;
    senderBlinding = orchWrap.blinding;

    // Transfer half to Bob
    const transferAmount  = senderBalance / 2n;
    const bobCountBefore  = await inboxClient.count(bob.address);

    const orchXfer = await orchestrateShieldedTransfer({
      currentBalance:    senderBalance,
      currentBlinding:   senderBlinding,
      transferAmount,
      senderMemoKeypair: { privkey: 0n, pubkey: senderJub.pubkey },
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
    console.log(`[Inbox] Sender shieldedTransfer tx: ${xferTx.hash}`);

    // Update sender state
    senderBalance  = orchXfer.newBalance;
    senderBlinding = orchXfer.newBlinding;

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
    const notes       = await inboxClient.peek(bob.address, 0n, 1n);

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

    // Send another note from sender (has remaining balance from step 3)
    const janusFlow = new ethers.Contract(ADDRESSES.janusFlow, JANUS_FLOW_ABI, sender.wallet);

    // Sender still has remaining balance from the first wrap
    expect(senderBalance).toBeGreaterThan(0n);

    const transferAmount = senderBalance > 10n ? senderBalance / 5n : senderBalance;
    const memo           = "drain-and-decrypt test";

    const orchXfer = await orchestrateShieldedTransfer({
      currentBalance:    senderBalance,
      currentBlinding:   senderBlinding,
      transferAmount,
      senderMemoKeypair: { privkey: 0n, pubkey: senderJub.pubkey },
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

    senderBalance  = orchXfer.newBalance;
    senderBlinding = orchXfer.newBlinding;

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
