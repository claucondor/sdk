/**
 * tests/e2e/flow-lifecycle.test.ts
 *
 * Full FLOW lifecycle via SDK public API only.
 *
 * Uses a FRESH sender account (not the deployer) to avoid C_old mismatch from
 * prior integration tests that may have left stale commitment state on the
 * deployer address. The deployer only funds fresh accounts.
 *
 * Protocol:
 *   1. Fresh sender + Bob funded via deployer
 *   2. Both publish memokeys via sdk.token('flow')
 *   3. Sender wraps 0.02 FLOW via adapter.wrap() + parse event to recover blinding
 *   4. Sender shieldedTransfers 0.005 FLOW to Bob via sdk.token('flow').shieldedTransfer()
 *   5. Bob drains inbox via ShieldedInboxClient and decodes note
 *   6. Sender unwraps remaining balance via sdk.token('flow').unwrap()
 *
 * Blinding recovery after wrap:
 *   adapter.wrap() does not return blinding. We recover it by parsing the
 *   WrapWithSnapshot event from the tx receipt and calling adapter.decryptSnapshot().
 *
 * Gated by RUN_E2E=1.
 * Run with: RUN_E2E=1 npm run test:e2e
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
  ShieldedCheckpointClient,
} from "../../src/index";

const SKIP = process.env.RUN_E2E !== "1";

// WrapWithSnapshot event ABI fragment (for parsing tx receipt without ethers.Contract)
const WRAP_WITH_SNAPSHOT_SIG =
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)";
const wrapIface = new ethers.Interface([WRAP_WITH_SNAPSHOT_SIG]);

describe("E2E: FLOW full lifecycle via SDK public API", () => {
  const flowAdapter      = sdk.token("flow");
  const inboxClient      = new ShieldedInboxClient();
  const checkpointClient = new ShieldedCheckpointClient();
  const provider         = makeProvider();

  // Use fresh sender (not deployer) to avoid C_old mismatch
  let sender: Awaited<ReturnType<typeof createFundedAccount>>;
  let bob:    Awaited<ReturnType<typeof createFundedAccount>>;

  let senderJub: Awaited<ReturnType<typeof deriveMemoJub>>;
  let bobJub:    Awaited<ReturnType<typeof deriveMemoJub>>;

  let senderBalance:  bigint;
  let senderBlinding: bigint;

  // Small amounts to stay within testnet FLOW budget
  const WRAP_AMOUNT     = 2n * 10n ** 16n;           // 0.02 FLOW (recovered via unwrap)
  const TRANSFER_AMOUNT = 5n * 10n ** 15n;            // 0.005 FLOW
  const MEMO_TEXT       = "e2e-flow-lifecycle-test";

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotE2E();

    // Deployer (Alice) funds fresh accounts
    const alice = makeAlice();
    sender = await createFundedAccount("0.06"); // gas (0.04) + wrap (0.02) recovered via unwrap
    bob    = await createFundedAccount("0.005");

    senderJub = await deriveMemoJub(sender.address, "e2e-flow:sender:v1");
    bobJub    = await deriveMemoJub(bob.address,    "e2e-flow:bob:v1");

    // Publish memokeys via SDK adapter (sender and bob pay their own gas)
    const senderKey = await flowAdapter.getMemoKey(sender.address);
    if (!senderKey) {
      await flowAdapter.publishMemoKey(senderJub, sender.wallet);
    } else if (senderKey.x !== senderJub.pubkey.x || senderKey.y !== senderJub.pubkey.y) {
      await flowAdapter.rotateMemoKey(senderJub, sender.wallet);
    }

    const bobKey = await flowAdapter.getMemoKey(bob.address);
    if (!bobKey) {
      await flowAdapter.publishMemoKey(bobJub, bob.wallet);
    }

    // Clean Bob's inbox
    const bobCount = await inboxClient.count(bob.address);
    if (bobCount > 0n) {
      console.log(`[E2E:FLOW] Pre-draining ${bobCount} leftover notes from Bob`);
      await inboxClient.drainAll(bob.wallet);
    }

    console.log(`[E2E:FLOW] Sender (fresh): ${sender.address} (${sender.fundTxHash})`);
    console.log(`[E2E:FLOW] Bob (fresh):    ${bob.address} (${bob.fundTxHash})`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 1 — wrap via adapter.wrap() + parse event to recover blinding
  // ---------------------------------------------------------------------------

  it("should wrap FLOW and recover blinding from WrapWithSnapshot event", async () => {
    if (SKIP) return;

    const wrapResult = await flowAdapter.wrap(
      { grossAmount: WRAP_AMOUNT },
      sender.wallet,
    );

    expect(wrapResult.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(wrapResult.netAmount).toBeGreaterThan(0n);
    expect(wrapResult.fee).toBeGreaterThanOrEqual(0n);
    console.log(`[E2E:FLOW] wrap tx: ${wrapResult.txHash}, netAmount: ${wrapResult.netAmount}`);

    // Recover blinding by parsing WrapWithSnapshot event from receipt
    const receipt = await provider.getTransactionReceipt(wrapResult.txHash);
    expect(receipt).not.toBeNull();

    let snapshotDecrypted = false;
    for (const log of receipt!.logs) {
      try {
        const parsed = wrapIface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "WrapWithSnapshot") {
          const encBytes = ethers.getBytes(parsed.args.encryptedSnapshot);
          const ephX     = BigInt(parsed.args.ephPubkeyX);
          const ephY     = BigInt(parsed.args.ephPubkeyY);

          // Decrypt snapshot using adapter.decryptSnapshot() — SDK public API
          const snap = await flowAdapter.decryptSnapshot(
            encBytes,
            { x: ephX, y: ephY },
            senderJub.privkey,
          );

          expect(snap.balance).toBeGreaterThan(0n);
          expect(snap.blinding).toBeGreaterThan(0n);

          senderBalance  = snap.balance;
          senderBlinding = snap.blinding;
          snapshotDecrypted = true;
          console.log(`[E2E:FLOW] recovered balance: ${snap.balance}`);
          break;
        }
      } catch {
        // Not this event, continue
      }
    }

    expect(snapshotDecrypted).toBe(true);
    expect(senderBalance).toBe(wrapResult.netAmount);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 2 — shieldedTransfer to Bob via SDK adapter
  // ---------------------------------------------------------------------------

  it("should shieldedTransfer to Bob via SDK adapter", async () => {
    if (SKIP) return;

    const bobCountBefore = await inboxClient.count(bob.address);

    const sendResult = await flowAdapter.shieldedTransfer(
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

    // Update checkpoint via ShieldedCheckpointClient
    if (sendResult.checkpointPayload) {
      await checkpointClient.update(sendResult.checkpointPayload, 0n, sender.wallet);
    }

    console.log(`[E2E:FLOW] transfer tx: ${sendResult.txHash}`);
    console.log(`[E2E:FLOW] Sender remaining: ${senderBalance}, Bob inbox: ${bobCountAfter}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 3 — Bob drains and decodes via SDK
  // ---------------------------------------------------------------------------

  it("should drain Bob inbox and decode correct amount + memo", async () => {
    if (SKIP) return;

    const { notes, decrypted, failed, txHash } =
      await inboxClient.drainAndDecrypt(bob.wallet, bobJub.privkey);

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(decrypted.length).toBeGreaterThan(0);
    expect(failed.length).toBe(0);

    const decoded = decrypted[0].content;
    expect(decoded.amount).toBe(TRANSFER_AMOUNT);
    expect(decoded.memo).toBe(MEMO_TEXT);

    expect(decrypted[0].note.depositor.toLowerCase()).toBe(
      ADDRESSES.janusFlow.toLowerCase()
    );

    console.log(
      `[E2E:FLOW] drain tx: ${txHash}, amount: ${decoded.amount}, memo: "${decoded.memo}"`
    );
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Step 4 — Sender unwraps remaining via SDK adapter
  // ---------------------------------------------------------------------------

  it("should unwrap remaining FLOW via SDK adapter.unwrap()", async () => {
    if (SKIP) return;

    const balanceBefore = await flowAdapter.getBalance(sender.address);

    const unwrapResult = await flowAdapter.unwrap(
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

    const balanceAfter = await flowAdapter.getBalance(sender.address);
    // Balance should increase by approximately netToRecipient minus gas
    const gasAllowance = 10n ** 16n; // 0.01 FLOW
    expect(balanceAfter + gasAllowance).toBeGreaterThan(balanceBefore);

    console.log(
      `[E2E:FLOW] unwrap tx: ${unwrapResult.txHash}, ` +
      `netToRecipient: ${unwrapResult.netToRecipient}`
    );
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Sanity: checkpoint metadata shows hasCheckpoint=true for sender
  // ---------------------------------------------------------------------------

  it("sender should have a checkpoint on-chain", async () => {
    if (SKIP) return;

    const meta = await checkpointClient.metadata(sender.address);
    expect(meta.hasCheckpoint).toBe(true);
    console.log(`[E2E:FLOW] checkpoint version=${meta.version}, cursor=${meta.lastConsumedNoteIndex}`);
  }, 15_000);
});
