/**
 * tests/integration/adapters/janus-flow.test.ts
 *
 * Integration tests for JanusFlowAdapter — full wrap → transfer → drain → decode → unwrap
 * lifecycle against deployed v0.8 testnet contracts.
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
  ONE_FLOW,
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

  let alice: ReturnType<typeof makeDeployerWallet>;
  let bob:   Awaited<ReturnType<typeof createFreshBob>>;

  let aliceJub: Awaited<ReturnType<typeof deriveMemoKeypair>>;
  let bobJub:   Awaited<ReturnType<typeof deriveMemoKeypair>>;

  // Mutable state captured across tests
  let aliceBalance:  bigint;
  let aliceBlinding: bigint;

  const TRANSFER_AMOUNT = 3n * 10n ** 17n; // 0.3 FLOW
  const MEMO_TEXT = "janus-flow-adapter-integration";

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotIntegration();

    alice = makeDeployerWallet();
    bob   = await createFreshBob("0.1");

    aliceJub = await deriveMemoKeypair(alice.address, "janus-flow-adapter-test:alice");
    bobJub   = await deriveMemoKeypair(bob.address,   "janus-flow-adapter-test:bob");

    // Ensure both have published memokeys via adapter SDK methods
    const aliceKey = await adapter.getMemoKey(alice.address);
    if (!aliceKey) {
      await adapter.publishMemoKey(aliceJub, alice);
    } else if (aliceKey.x !== aliceJub.pubkey.x || aliceKey.y !== aliceJub.pubkey.y) {
      await adapter.rotateMemoKey(aliceJub, alice);
    }

    const bobKey = await adapter.getMemoKey(bob.address);
    if (!bobKey) {
      await adapter.publishMemoKey(bobJub, bob.wallet);
    }

    // Drain Bob's inbox to start clean
    const bobCount = await inboxClient.count(bob.address);
    if (bobCount > 0n) {
      console.log(`[JanusFlow] Pre-draining ${bobCount} leftover notes from Bob's inbox`);
      await inboxClient.drainAll(bob.wallet);
    }

    console.log(`[JanusFlow] Alice: ${alice.address}`);
    console.log(`[JanusFlow] Bob:   ${bob.address} (funded: ${bob.fundTxHash})`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 1 — Wrap 1 FLOW (orchestrateWrap + direct contract to capture blinding)
  // ---------------------------------------------------------------------------

  it("should wrap 1 FLOW via SDK orchestrateWrap + submit to JanusFlow", async () => {
    if (SKIP) return;

    const feeBps = await adapter.feeBps();
    const orchWrap = await orchestrateWrap({
      grossAmount:       ONE_FLOW,
      feeBps,
      senderMemoKeypair: { privkey: 0n, pubkey: aliceJub.pubkey },
    });

    const janusFlow = new ethers.Contract(ADDRESSES.janusFlow, JANUS_FLOW_ABI, alice);
    const { pA, pB, pC } = splitProofForEvm(orchWrap.amountProof);

    const wrapTx = await janusFlow.wrapWithProof(
      orchWrap.nonce,
      [orchWrap.txCommit[0], orchWrap.txCommit[1]],
      pA, pB, pC,
      ethers.hexlify(orchWrap.encryptedSnapshot),
      orchWrap.ephPubkeyX,
      orchWrap.ephPubkeyY,
      { value: ONE_FLOW }
    );
    await wrapTx.wait(1);

    aliceBalance  = orchWrap.netAmount;
    aliceBlinding = orchWrap.blinding;

    expect(wrapTx.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(aliceBalance).toBeGreaterThan(0n);
    expect(aliceBlinding).toBeGreaterThan(0n);
    console.log(`[JanusFlow] wrap tx: ${wrapTx.hash}, netAmount: ${aliceBalance}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 2 — shieldedTransfer 0.3 FLOW to Bob via adapter.shieldedTransfer()
  // ---------------------------------------------------------------------------

  it("should shieldedTransfer 0.3 FLOW to Bob via adapter SDK method", async () => {
    if (SKIP) return;

    const bobCountBefore = await inboxClient.count(bob.address);

    const sendResult = await adapter.shieldedTransfer(
      {
        recipient:       bob.address,
        amount:          TRANSFER_AMOUNT,
        memo:            MEMO_TEXT,
        currentBalance:  aliceBalance,
        currentBlinding: aliceBlinding,
      },
      alice,
    );

    expect(sendResult.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(sendResult.newBalance).toBeDefined();
    expect(sendResult.newBlinding).toBeDefined();
    expect(sendResult.checkpointPayload).toBeDefined();

    // Update state for subsequent tests
    aliceBalance  = sendResult.newBalance!;
    aliceBlinding = sendResult.newBlinding!;

    // Bob's inbox should have grown
    const bobCountAfter = await inboxClient.count(bob.address);
    expect(bobCountAfter).toBe(bobCountBefore + 1n);

    console.log(`[JanusFlow] shieldedTransfer tx: ${sendResult.txHash}`);
    console.log(`[JanusFlow] Alice remaining: ${aliceBalance}, Bob inbox: ${bobCountAfter}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 3 — Store Alice's checkpoint via ShieldedCheckpointClient
  // ---------------------------------------------------------------------------

  it("should write Alice's checkpoint after transfer via SDK", async () => {
    if (SKIP) return;

    // Reconstruct checkpoint payload from shieldedTransfer result
    // (checkpointPayload is returned by adapter.shieldedTransfer)
    // For simplicity, use encryptAndUpdate with the current balance/blinding
    const { txHash, version } = await checkpointClient.encryptAndUpdate(
      { balance: aliceBalance, blinding: aliceBlinding },
      1n, // consumed 1 inbox note cursor
      aliceJub,
      alice,
    );

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(version).toBeGreaterThanOrEqual(1n);
    console.log(`[JanusFlow] checkpoint update tx: ${txHash}, v=${version}`);

    // Verify round-trip
    const snap = await checkpointClient.readAndDecrypt(alice, aliceJub.privkey);
    expect(snap).not.toBeNull();
    expect(snap!.balance).toBe(aliceBalance);
    expect(snap!.blinding).toBe(aliceBlinding);
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
  // Step 5 — Alice unwraps remaining balance via adapter.unwrap()
  // ---------------------------------------------------------------------------

  it("should unwrap remaining balance via adapter.unwrap() SDK method", async () => {
    if (SKIP) return;

    const balanceBefore = await provider.getBalance(alice.address);

    const unwrapResult = await adapter.unwrap(
      {
        claimedAmount:   aliceBalance,
        recipient:       alice.address,
        currentBalance:  aliceBalance,
        currentBlinding: aliceBlinding,
      },
      alice,
    );

    expect(unwrapResult.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(unwrapResult.netToRecipient).toBeGreaterThan(0n);

    const balanceAfter = await provider.getBalance(alice.address);
    // Balance should have increased (net claim minus gas cost)
    // Allow up to 0.01 FLOW in gas loss
    const gasAllowance = 10n ** 16n;
    expect(balanceAfter + gasAllowance).toBeGreaterThan(balanceBefore);

    console.log(
      `[JanusFlow] unwrap tx: ${unwrapResult.txHash}, ` +
      `netToRecipient: ${unwrapResult.netToRecipient}`
    );
    console.log(`[JanusFlow] Alice balance delta: ${balanceAfter - balanceBefore}`);
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
