/**
 * tests/e2e/musdc-lifecycle.test.ts
 *
 * Full mUSDC lifecycle via SDK public API only.
 *
 * Uses a FRESH sender account (not the deployer) for all shielded mUSDC operations.
 * The deployer only mints mUSDC to the fresh sender and funds gas accounts.
 *
 * Protocol:
 *   1. Deployer mints 100 mUSDC to fresh sender
 *   2. Sender approves JanusERC20 proxy via adapter.approveUnderlying()
 *   3. Sender wraps 10 mUSDC via adapter.wrap() + parse event to recover blinding
 *   4. Sender shieldedTransfers 3 mUSDC to Bob via sdk.token('mockusdc').shieldedTransfer()
 *   5. Bob drains inbox and decodes note
 *   6. Sender unwraps remaining 7 mUSDC via sdk.token('mockusdc').unwrap()
 *
 * Blinding recovery: parsed from WrapWithSnapshot event + adapter.decryptSnapshot().
 *
 * Gated by RUN_E2E=1.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { ethers } from "ethers";
import {
  makeAlice,
  createFundedAccount,
  deriveMemoJub,
  skipIfNotE2E,
  makeProvider,
  ADDRESSES,
  AMOUNTS,
  sdk,
} from "./helpers/e2e-setup";
import {
  ShieldedInboxClient,
} from "../../src/index";

const SKIP = process.env.RUN_E2E !== "1";

// ERC20 event ABI fragment for WrapWithSnapshot (same sig for JanusERC20)
const WRAP_WITH_SNAPSHOT_SIG =
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)";
const wrapIface = new ethers.Interface([WRAP_WITH_SNAPSHOT_SIG]);

// MockUSDC.mint ABI (ethers.Interface, not ethers.Contract)
const MINT_SIG  = "function mint(address to, uint256 amount)";
const mintIface = new ethers.Interface([MINT_SIG]);

describe("E2E: mUSDC full lifecycle via SDK public API", () => {
  const erc20Adapter = sdk.token("mockusdc");
  const inboxClient  = new ShieldedInboxClient();
  const provider     = makeProvider();

  // Fresh sender for shielded operations (clean slot, no prior C_old)
  let sender: Awaited<ReturnType<typeof createFundedAccount>>;
  let bob:    Awaited<ReturnType<typeof createFundedAccount>>;

  let senderJub: Awaited<ReturnType<typeof deriveMemoJub>>;
  let bobJub:    Awaited<ReturnType<typeof deriveMemoJub>>;

  let senderBalance:  bigint;
  let senderBlinding: bigint;

  const GROSS_WRAP      = AMOUNTS.TEN_MUSDC;     // 10 mUSDC
  const TRANSFER_AMOUNT = AMOUNTS.THREE_MUSDC;   // 3 mUSDC
  const MEMO_TEXT       = "e2e-musdc-lifecycle-test";

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotE2E();

    const alice = makeAlice(); // deployer — minting only
    sender = await createFundedAccount("0.05"); // gas for ERC20 txs (~0.04 FLOW)
    bob    = await createFundedAccount("0.005");

    senderJub = await deriveMemoJub(sender.address, "e2e-musdc:sender:v1");
    bobJub    = await deriveMemoJub(bob.address,    "e2e-musdc:bob:v1");

    // Publish memokeys via SDK adapter methods
    const senderKey = await erc20Adapter.getMemoKey(sender.address);
    if (!senderKey) {
      await erc20Adapter.publishMemoKey(senderJub, sender.wallet);
    } else if (senderKey.x !== senderJub.pubkey.x || senderKey.y !== senderJub.pubkey.y) {
      await erc20Adapter.rotateMemoKey(senderJub, sender.wallet);
    }

    const bobKey = await erc20Adapter.getMemoKey(bob.address);
    if (!bobKey) {
      await erc20Adapter.publishMemoKey(bobJub, bob.wallet);
    }

    // Pre-clean Bob's inbox
    const bobCount = await inboxClient.count(bob.address);
    if (bobCount > 0n) {
      console.log(`[E2E:mUSDC] Pre-draining ${bobCount} leftover notes from Bob`);
      await inboxClient.drainAll(bob.wallet);
    }

    // Mint mUSDC to fresh sender using deployer (wallet.sendTransaction, no ethers.Contract)
    const mintCalldata = mintIface.encodeFunctionData("mint", [
      sender.address,
      AMOUNTS.HUNDRED_MUSDC,
    ]);
    const mintTx = await alice.sendTransaction({ to: ADDRESSES.mockUSDC, data: mintCalldata });
    await mintTx.wait(1);
    console.log(`[E2E:mUSDC] mint tx: ${mintTx.hash}`);

    console.log(`[E2E:mUSDC] Sender (fresh): ${sender.address} (${sender.fundTxHash})`);
    console.log(`[E2E:mUSDC] Bob (fresh):    ${bob.address} (${bob.fundTxHash})`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 1 — Approve JanusERC20 proxy via adapter.approveUnderlying() SDK method
  // ---------------------------------------------------------------------------

  it("should approve JanusERC20 proxy via adapter.approveUnderlying()", async () => {
    if (SKIP) return;

    // JanusERC20Adapter.approveUnderlying is a public SDK adapter method
    const { txHash } = await (erc20Adapter as any).approveUnderlying(GROSS_WRAP, sender.wallet);
    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    console.log(`[E2E:mUSDC] approve tx: ${txHash}`);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Step 2 — Wrap 10 mUSDC via adapter.wrap() + parse event for blinding
  // ---------------------------------------------------------------------------

  it("should wrap 10 mUSDC and recover blinding from WrapWithSnapshot event", async () => {
    if (SKIP) return;

    const wrapResult = await erc20Adapter.wrap(
      { grossAmount: GROSS_WRAP },
      sender.wallet,
    );

    expect(wrapResult.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(wrapResult.netAmount).toBeGreaterThan(0n);
    console.log(`[E2E:mUSDC] wrap tx: ${wrapResult.txHash}, netAmount: ${wrapResult.netAmount}`);

    // Recover blinding by parsing WrapWithSnapshot event from receipt
    const receipt = await provider.getTransactionReceipt(wrapResult.txHash);
    expect(receipt).not.toBeNull();

    let recovered = false;
    for (const log of receipt!.logs) {
      try {
        const parsed = wrapIface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "WrapWithSnapshot") {
          const encBytes = ethers.getBytes(parsed.args.encryptedSnapshot);
          const ephX     = BigInt(parsed.args.ephPubkeyX);
          const ephY     = BigInt(parsed.args.ephPubkeyY);

          // adapter.decryptSnapshot() is a public SDK adapter method
          const snap = await erc20Adapter.decryptSnapshot(
            encBytes,
            { x: ephX, y: ephY },
            senderJub.privkey,
          );

          expect(snap.balance).toBeGreaterThan(0n);
          senderBalance  = snap.balance;
          senderBlinding = snap.blinding;
          recovered = true;
          console.log(`[E2E:mUSDC] recovered balance: ${snap.balance} (${snap.balance / AMOUNTS.ONE_MUSDC} mUSDC)`);
          break;
        }
      } catch {
        // Not this event
      }
    }

    expect(recovered).toBe(true);
    expect(senderBalance).toBe(wrapResult.netAmount);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 3 — shieldedTransfer 3 mUSDC to Bob via SDK adapter
  // ---------------------------------------------------------------------------

  it("should shieldedTransfer 3 mUSDC to Bob via SDK adapter", async () => {
    if (SKIP) return;

    const bobCountBefore = await inboxClient.count(bob.address);

    const sendResult = await erc20Adapter.shieldedTransfer(
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

    senderBalance  = sendResult.newBalance!;
    senderBlinding = sendResult.newBlinding!;

    const bobCountAfter = await inboxClient.count(bob.address);
    expect(bobCountAfter).toBe(bobCountBefore + 1n);

    console.log(`[E2E:mUSDC] transfer tx: ${sendResult.txHash}`);
    console.log(`[E2E:mUSDC] Sender remaining: ${senderBalance}, Bob inbox: ${bobCountAfter}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 4 — Bob drains inbox and decodes mUSDC note
  // ---------------------------------------------------------------------------

  it("should drain Bob inbox and decode correct mUSDC amount + memo", async () => {
    if (SKIP) return;

    const { notes, decrypted, failed, txHash } =
      await inboxClient.drainAndDecrypt(bob.wallet, bobJub.privkey);

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(decrypted.length).toBeGreaterThan(0);
    expect(failed.length).toBe(0);

    const decoded = decrypted[0].content;
    expect(decoded.amount).toBe(TRANSFER_AMOUNT);
    expect(decoded.memo).toBe(MEMO_TEXT);

    // Verify depositor is JanusERC20 proxy (not JanusFlow)
    expect(decrypted[0].note.depositor.toLowerCase()).toBe(
      ADDRESSES.janusERC20.toLowerCase()
    );

    console.log(
      `[E2E:mUSDC] drain tx: ${txHash}, ` +
      `amount: ${decoded.amount} (${decoded.amount / AMOUNTS.ONE_MUSDC} mUSDC), ` +
      `memo: "${decoded.memo}"`
    );
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Step 5 — Sender unwraps remaining mUSDC
  // ---------------------------------------------------------------------------

  it("should unwrap remaining mUSDC via SDK adapter.unwrap()", async () => {
    if (SKIP) return;

    const balanceBefore = await erc20Adapter.getBalance(sender.address);

    const unwrapResult = await erc20Adapter.unwrap(
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

    const balanceAfter = await erc20Adapter.getBalance(sender.address);
    expect(balanceAfter).toBeGreaterThan(balanceBefore);

    console.log(
      `[E2E:mUSDC] unwrap tx: ${unwrapResult.txHash}, ` +
      `netToRecipient: ${unwrapResult.netToRecipient} (${unwrapResult.netToRecipient / AMOUNTS.ONE_MUSDC} mUSDC)`
    );
  }, 120_000);
});
