/**
 * tests/integration/adapters/janus-erc20.test.ts
 *
 * Integration tests for JanusERC20Adapter — full wrap → transfer → drain → decode → unwrap
 * lifecycle for MockUSDC (mUSDC) against deployed v0.8 testnet contracts.
 *
 * Approach:
 *   - Minting: Alice (deployer) mints mUSDC to herself via direct ethers contract call.
 *   - Approve: uses adapter.approveUnderlying() — SDK adapter method.
 *   - Wrap step: uses orchestrateWrap (SDK proof builder) + direct ethers submit
 *     to capture blinding (adapter.wrap() does not expose blinding in WrapResult).
 *   - Transfer: uses adapter.shieldedTransfer() — full SDK adapter path.
 *   - Drain + decode: uses ShieldedInboxClient.drainAndDecrypt() — full SDK path.
 *   - Unwrap: uses adapter.unwrap() — full SDK adapter path.
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
  JANUS_ERC20_ABI,
  MOCK_USDC_ABI,
  ONE_MUSDC,
  HUNDRED_MUSDC,
  splitProofForEvm,
} from "../helpers/testnet";
import {
  JanusERC20Adapter,
  ShieldedInboxClient,
  TOKEN_REGISTRY,
  orchestrateWrap,
} from "../../../src/index";

const SKIP = process.env.RUN_INTEGRATION !== "1";

describe("JanusERC20Adapter — integration (mUSDC)", () => {
  const adapter     = new JanusERC20Adapter("mockusdc", TOKEN_REGISTRY.mockusdc);
  const inboxClient = new ShieldedInboxClient();

  let alice: ReturnType<typeof makeDeployerWallet>;
  let bob:   Awaited<ReturnType<typeof createFreshBob>>;

  let aliceJub: Awaited<ReturnType<typeof deriveMemoKeypair>>;
  let bobJub:   Awaited<ReturnType<typeof deriveMemoKeypair>>;

  // Mutable state captured across tests
  let aliceBalance:  bigint;
  let aliceBlinding: bigint;

  // Use 10 mUSDC gross wrap amount; transfer 3 mUSDC to Bob
  const GROSS_AMOUNT    = 10n * ONE_MUSDC;  // 10 mUSDC
  const TRANSFER_AMOUNT = 3n  * ONE_MUSDC;  // 3 mUSDC
  const MEMO_TEXT       = "janus-erc20-adapter-integration";

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotIntegration();

    alice = makeDeployerWallet();
    bob   = await createFreshBob("0.05");

    aliceJub = await deriveMemoKeypair(alice.address, "janus-erc20-adapter-test:alice");
    bobJub   = await deriveMemoKeypair(bob.address,   "janus-erc20-adapter-test:bob");

    // Ensure both have memokeys published via adapter SDK methods
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
      console.log(`[JanusERC20] Pre-draining ${bobCount} leftover notes from Bob's inbox`);
      await inboxClient.drainAll(bob.wallet);
    }

    console.log(`[JanusERC20] Alice: ${alice.address}`);
    console.log(`[JanusERC20] Bob:   ${bob.address} (funded: ${bob.fundTxHash})`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 1 — Mint + Approve mUSDC
  // ---------------------------------------------------------------------------

  it("should mint 100 mUSDC to Alice and approve JanusERC20 proxy", async () => {
    if (SKIP) return;

    // Mint 100 mUSDC to Alice (deployer owns MockUSDC mint function)
    const mockUSDC = new ethers.Contract(ADDRESSES.mockUSDC, MOCK_USDC_ABI, alice);
    const mintTx   = await mockUSDC.mint(alice.address, HUNDRED_MUSDC);
    await mintTx.wait(1);
    console.log(`[JanusERC20] mint tx: ${mintTx.hash}`);

    const balance = await adapter.getBalance(alice.address);
    expect(balance).toBeGreaterThanOrEqual(GROSS_AMOUNT);
    console.log(`[JanusERC20] Alice mUSDC balance: ${balance}`);

    // Approve via adapter SDK method
    const { txHash } = await adapter.approveUnderlying(GROSS_AMOUNT, alice);
    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    console.log(`[JanusERC20] approve tx: ${txHash}`);
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Step 2 — Wrap 10 mUSDC (orchestrateWrap + direct contract to capture blinding)
  // ---------------------------------------------------------------------------

  it("should wrap 10 mUSDC via SDK orchestrateWrap + submit to JanusERC20", async () => {
    if (SKIP) return;

    const feeBps  = await adapter.feeBps();
    const orchWrap = await orchestrateWrap({
      grossAmount:       GROSS_AMOUNT,
      feeBps,
      senderMemoKeypair: { privkey: 0n, pubkey: aliceJub.pubkey },
    });

    const janusERC20 = new ethers.Contract(ADDRESSES.janusERC20, JANUS_ERC20_ABI, alice);
    const { pA, pB, pC } = splitProofForEvm(orchWrap.amountProof);

    const wrapTx = await janusERC20.wrapWithProof(
      GROSS_AMOUNT,
      orchWrap.nonce,
      [orchWrap.txCommit[0], orchWrap.txCommit[1]],
      pA, pB, pC,
      ethers.hexlify(orchWrap.encryptedSnapshot),
      orchWrap.ephPubkeyX,
      orchWrap.ephPubkeyY,
    );
    await wrapTx.wait(1);

    aliceBalance  = orchWrap.netAmount;
    aliceBlinding = orchWrap.blinding;

    expect(wrapTx.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(aliceBalance).toBeGreaterThan(0n);
    expect(aliceBlinding).toBeGreaterThan(0n);
    console.log(`[JanusERC20] wrap tx: ${wrapTx.hash}, netAmount: ${aliceBalance}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 3 — shieldedTransfer 3 mUSDC to Bob via adapter.shieldedTransfer()
  // ---------------------------------------------------------------------------

  it("should shieldedTransfer 3 mUSDC to Bob via adapter SDK method", async () => {
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

    aliceBalance  = sendResult.newBalance!;
    aliceBlinding = sendResult.newBlinding!;

    const bobCountAfter = await inboxClient.count(bob.address);
    expect(bobCountAfter).toBe(bobCountBefore + 1n);

    console.log(`[JanusERC20] shieldedTransfer tx: ${sendResult.txHash}`);
    console.log(`[JanusERC20] Alice remaining: ${aliceBalance}, Bob inbox: ${bobCountAfter}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 4 — Bob drains inbox and decodes the mUSDC note
  // ---------------------------------------------------------------------------

  it("should drain Bob's inbox and decode correct mUSDC amount + memo", async () => {
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

    // Depositor must be JanusERC20 proxy (not JanusFlow)
    expect(decrypted[0].note.depositor.toLowerCase()).toBe(
      ADDRESSES.janusERC20.toLowerCase()
    );

    console.log(
      `[JanusERC20] drainAndDecrypt tx: ${txHash}, ` +
      `amount: ${decoded.amount} (${decoded.amount / ONE_MUSDC} mUSDC), ` +
      `memo: "${decoded.memo}"`
    );
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Step 5 — Alice unwraps remaining mUSDC balance via adapter.unwrap()
  // ---------------------------------------------------------------------------

  it("should unwrap remaining mUSDC via adapter.unwrap() SDK method", async () => {
    if (SKIP) return;

    const balanceBefore = await adapter.getBalance(alice.address);

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

    const balanceAfter = await adapter.getBalance(alice.address);
    expect(balanceAfter).toBeGreaterThan(balanceBefore);

    console.log(
      `[JanusERC20] unwrap tx: ${unwrapResult.txHash}, ` +
      `netToRecipient: ${unwrapResult.netToRecipient} (${unwrapResult.netToRecipient / ONE_MUSDC} mUSDC)`
    );
    console.log(`[JanusERC20] Alice mUSDC delta: ${balanceAfter - balanceBefore}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Metadata checks
  // ---------------------------------------------------------------------------

  it("adapter metadata should match TOKEN_REGISTRY and ADDRESSES constants", () => {
    if (SKIP) return;

    expect(adapter.address).toBe(ADDRESSES.janusERC20);
    expect(adapter.underlyingAddress).toBe(ADDRESSES.mockUSDC);
    expect(adapter.memoRegistryAddress).toBe(ADDRESSES.memoKeyRegistry);
    expect(adapter.variant).toBe("erc20");
    expect(adapter.decimals).toBe(6);
  });
});
