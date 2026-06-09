/**
 * tests/integration/adapters/janus-flow.test.ts
 *
 * Integration tests for JanusFlowAdapter — full wrap → transfer → drain → decode → unwrap
 * lifecycle against deployed v0.8 testnet contracts.
 *
 * Uses a FRESH sender account (not the deployer) to avoid C_old mismatch from
 * prior test runs that may have left stale commitment state on the deployer address.
 *
 * Approach:
 *   - Wrap step: uses orchestrateWrap (SDK proof builder) + direct ethers contract submit
 *     to capture blinding (adapter.wrap() does not expose blinding in WrapResult).
 *   - Transfer step: uses adapter.shieldedTransfer() — full SDK adapter path.
 *   - Drain + decode: uses ShieldedInboxClient.drainAndDecrypt() — full SDK path.
 *   - Unwrap step: uses adapter.unwrap() — full SDK adapter path.
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
  provider,
} from "../helpers/testnet";
import {
  JanusFlowAdapter,
  ShieldedInboxClient,
  ShieldedCheckpointClient,
  TOKEN_REGISTRY,
  orchestrateWrap,
} from "../../../src/index";

const SKIP = process.env.RUN_INTEGRATION !== "1";

describe("JanusFlowAdapter — integration", () => {
  const adapter          = new JanusFlowAdapter("flow", TOKEN_REGISTRY.flow);
  const inboxClient      = new ShieldedInboxClient();
  const checkpointClient = new ShieldedCheckpointClient();

  // Use fresh random sender (not deployer) to avoid C_old mismatch with prior runs.
  let sender:  Awaited<ReturnType<typeof createFreshBob>>;
  let bob:     Awaited<ReturnType<typeof createFreshBob>>;

  let senderJub: Awaited<ReturnType<typeof deriveMemoKeypair>>;
  let bobJub:    Awaited<ReturnType<typeof deriveMemoKeypair>>;

  // Mutable state captured across tests
  let senderBalance:  bigint;
  let senderBlinding: bigint;

  // Use tiny amounts to stay within testnet FLOW budget
  const WRAP_AMOUNT     = TINY_FLOW;                // 0.02 FLOW gross
  const TRANSFER_AMOUNT = MICRO_FLOW;               // 0.005 FLOW
  const MEMO_TEXT       = "janus-flow-adapter-integration";

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotIntegration();

    // Fund sender and bob from deployer wallet (small amounts to save budget)
    sender = await createFreshBob("0.02");
    bob    = await createFreshBob("0.01");

    senderJub = await deriveMemoKeypair(sender.address, "janus-flow-adapter-test:sender");
    bobJub    = await deriveMemoKeypair(bob.address,    "janus-flow-adapter-test:bob");

    // Publish memokeys via adapter SDK methods (sender pays its own gas)
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

    // Drain Bob's inbox to start clean
    const bobCount = await inboxClient.count(bob.address);
    if (bobCount > 0n) {
      console.log(`[JanusFlow] Pre-draining ${bobCount} leftover notes from Bob`);
      await inboxClient.drainAll(bob.wallet);
    }

    console.log(`[JanusFlow] Sender: ${sender.address} (fresh, funded: ${sender.fundTxHash})`);
    console.log(`[JanusFlow] Bob:    ${bob.address} (funded: ${bob.fundTxHash})`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 1 — Wrap 0.02 FLOW (orchestrateWrap + direct contract to capture blinding)
  // ---------------------------------------------------------------------------

  it("should wrap 0.02 FLOW via SDK orchestrateWrap + submit to JanusFlow", async () => {
    if (SKIP) return;

    const feeBps = await adapter.feeBps();
    const orchWrap = await orchestrateWrap({
      grossAmount:       WRAP_AMOUNT,
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
      { value: WRAP_AMOUNT }
    );
    await wrapTx.wait(1);

    senderBalance  = orchWrap.netAmount;
    senderBlinding = orchWrap.blinding;

    expect(wrapTx.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(senderBalance).toBeGreaterThan(0n);
    expect(senderBlinding).toBeGreaterThan(0n);
    console.log(`[JanusFlow] wrap tx: ${wrapTx.hash}, netAmount: ${senderBalance}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 2 — shieldedTransfer 0.005 FLOW to Bob via adapter.shieldedTransfer()
  // ---------------------------------------------------------------------------

  it("should shieldedTransfer to Bob via adapter SDK method", async () => {
    if (SKIP) return;

    const bobCountBefore = await inboxClient.count(bob.address);

    const sendResult = await adapter.shieldedTransfer(
      {
        recipient:       bob.address,
        amount:          TRANSFER_AMOUNT,
        memo:            MEMO_TEXT,
        currentBalance:  senderBalance,
        currentBlinding: senderBlinding,
      },
      sender.wallet,
    );

    expect(sendResult.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(sendResult.newBalance).toBeDefined();
    expect(sendResult.newBlinding).toBeDefined();
    expect(sendResult.checkpointPayload).toBeDefined();

    // Update state for subsequent tests
    senderBalance  = sendResult.newBalance!;
    senderBlinding = sendResult.newBlinding!;

    // Bob's inbox should have grown
    const bobCountAfter = await inboxClient.count(bob.address);
    expect(bobCountAfter).toBe(bobCountBefore + 1n);

    console.log(`[JanusFlow] shieldedTransfer tx: ${sendResult.txHash}`);
    console.log(`[JanusFlow] Sender remaining: ${senderBalance}, Bob inbox: ${bobCountAfter}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 3 — Store sender's checkpoint via ShieldedCheckpointClient
  // ---------------------------------------------------------------------------

  it("should write sender checkpoint after transfer via SDK", async () => {
    if (SKIP) return;

    const { txHash, version } = await checkpointClient.encryptAndUpdate(
      { balance: senderBalance, blinding: senderBlinding },
      1n, // consumed 1 inbox note cursor
      senderJub,
      sender.wallet,
    );

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(version).toBeGreaterThanOrEqual(1n);
    console.log(`[JanusFlow] checkpoint update tx: ${txHash}, v=${version}`);

    // Verify round-trip
    const snap = await checkpointClient.readAndDecrypt(sender.wallet, senderJub.privkey);
    expect(snap).not.toBeNull();
    expect(snap!.balance).toBe(senderBalance);
    expect(snap!.blinding).toBe(senderBlinding);
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Step 4 — Bob drains inbox and decodes the note via SDK
  // ---------------------------------------------------------------------------

  it("should drain Bob's inbox and decode correct amount + memo", async () => {
    if (SKIP) return;

    const { notes, decrypted, failed, txHash } =
      await inboxClient.drainAndDecrypt(bob.wallet, bobJub.privkey);

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(notes.length).toBeGreaterThan(0);
    expect(decrypted.length).toBeGreaterThan(0);
    expect(failed.length).toBe(0);

    const decoded = decrypted[0].content;
    expect(decoded.amount).toBe(TRANSFER_AMOUNT);
    expect(decoded.memo).toBe(MEMO_TEXT);

    // Verify depositor field identifies JanusFlow proxy
    expect(decrypted[0].note.depositor.toLowerCase()).toBe(
      ADDRESSES.janusFlow.toLowerCase()
    );

    console.log(
      `[JanusFlow] drainAndDecrypt tx: ${txHash}, ` +
      `amount: ${decoded.amount}, memo: "${decoded.memo}"`
    );
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Step 5 — Sender unwraps remaining balance via adapter.unwrap()
  // ---------------------------------------------------------------------------

  it("should unwrap remaining balance via adapter.unwrap() SDK method", async () => {
    if (SKIP) return;

    const balanceBefore = await provider.getBalance(sender.address);

    const unwrapResult = await adapter.unwrap(
      {
        claimedAmount:   senderBalance,
        recipient:       sender.address,
        currentBalance:  senderBalance,
        currentBlinding: senderBlinding,
      },
      sender.wallet,
    );

    expect(unwrapResult.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(unwrapResult.netToRecipient).toBeGreaterThan(0n);

    const balanceAfter = await provider.getBalance(sender.address);
    // Balance should have increased (net claim minus gas cost)
    const gasAllowance = 10n ** 16n;
    expect(balanceAfter + gasAllowance).toBeGreaterThan(balanceBefore);

    console.log(
      `[JanusFlow] unwrap tx: ${unwrapResult.txHash}, ` +
      `netToRecipient: ${unwrapResult.netToRecipient}`
    );
    console.log(`[JanusFlow] Sender balance delta: ${balanceAfter - balanceBefore}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Metadata checks
  // ---------------------------------------------------------------------------

  it("adapter metadata should match TOKEN_REGISTRY and ADDRESSES constants", () => {
    if (SKIP) return;

    expect(adapter.address).toBe(ADDRESSES.janusFlow);
    expect(adapter.memoRegistryAddress).toBe(ADDRESSES.memoKeyRegistry);
    expect(adapter.variant).toBe("native");
    expect(adapter.decimals).toBe(18);
  });
});
