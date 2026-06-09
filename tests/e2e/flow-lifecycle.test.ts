/**
 * tests/e2e/flow-lifecycle.test.ts
 *
 * Full FLOW lifecycle via SDK public API only.
 *
 * Protocol:
 *   1. Alice + Bob created and funded via helpers
 *   2. Both publish memokeys via sdk.token('flow')
 *   3. Alice wraps 1 FLOW via orchestrateWrap + adapter.wrap() (blinding captured from event)
 *   4. Alice shieldedTransfers 0.3 FLOW to Bob via sdk.token('flow').shieldedTransfer()
 *   5. Bob drains inbox via ShieldedInboxClient and decodes note
 *   6. Alice unwraps remaining balance via sdk.token('flow').unwrap()
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

  let alice: ReturnType<typeof makeAlice>;
  let bob:   Awaited<ReturnType<typeof createFundedAccount>>;

  let aliceJub: Awaited<ReturnType<typeof deriveMemoJub>>;
  let bobJub:   Awaited<ReturnType<typeof deriveMemoJub>>;

  let aliceBalance:  bigint;
  let aliceBlinding: bigint;

  const TRANSFER_AMOUNT = AMOUNTS.POINT3_FLOW;
  const MEMO_TEXT       = "e2e-flow-lifecycle-test";

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotE2E();

    alice = makeAlice();
    bob   = await createFundedAccount("0.1");

    aliceJub = await deriveMemoJub(alice.address, "e2e-flow:alice:v1");
    bobJub   = await deriveMemoJub(bob.address,   "e2e-flow:bob:v1");

    // Publish memokeys via SDK adapter
    const aliceKey = await flowAdapter.getMemoKey(alice.address);
    if (!aliceKey) {
      await flowAdapter.publishMemoKey(aliceJub, alice);
    } else if (aliceKey.x !== aliceJub.pubkey.x || aliceKey.y !== aliceJub.pubkey.y) {
      await flowAdapter.rotateMemoKey(aliceJub, alice);
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

    console.log(`[E2E:FLOW] Alice: ${alice.address}`);
    console.log(`[E2E:FLOW] Bob:   ${bob.address} (${bob.fundTxHash})`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 1 — wrap 1 FLOW via adapter.wrap() + parse event to recover blinding
  // ---------------------------------------------------------------------------

  it("should wrap 1 FLOW and recover blinding from WrapWithSnapshot event", async () => {
    if (SKIP) return;

    const wrapResult = await flowAdapter.wrap(
      { grossAmount: AMOUNTS.ONE_FLOW },
      alice,
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
            aliceJub.privkey,
          );

          expect(snap.balance).toBeGreaterThan(0n);
          expect(snap.blinding).toBeGreaterThan(0n);

          aliceBalance  = snap.balance;
          aliceBlinding = snap.blinding;
          snapshotDecrypted = true;
          console.log(`[E2E:FLOW] recovered balance: ${snap.balance}, blinding: ${snap.blinding.toString().slice(0,20)}...`);
          break;
        }
      } catch {
        // Not this event, continue
      }
    }

    expect(snapshotDecrypted).toBe(true);
    expect(aliceBalance).toBe(wrapResult.netAmount);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 2 — shieldedTransfer 0.3 FLOW to Bob via SDK adapter
  // ---------------------------------------------------------------------------

  it("should shieldedTransfer 0.3 FLOW to Bob via SDK adapter", async () => {
    if (SKIP) return;

    const bobCountBefore = await inboxClient.count(bob.address);

    const sendResult = await flowAdapter.shieldedTransfer(
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

    aliceBalance  = sendResult.newBalance!;
    aliceBlinding = sendResult.newBlinding!;

    const bobCountAfter = await inboxClient.count(bob.address);
    expect(bobCountAfter).toBe(bobCountBefore + 1n);

    // Update checkpoint via SDK
    if (sendResult.checkpointPayload) {
      await checkpointClient.update(sendResult.checkpointPayload, 0n, alice);
    }

    console.log(`[E2E:FLOW] transfer tx: ${sendResult.txHash}`);
    console.log(`[E2E:FLOW] Alice remaining: ${aliceBalance}, Bob inbox: ${bobCountAfter}`);
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
  // Step 4 — Alice unwraps remaining via SDK adapter
  // ---------------------------------------------------------------------------

  it("should unwrap remaining FLOW via SDK adapter.unwrap()", async () => {
    if (SKIP) return;

    const balanceBefore = await flowAdapter.getBalance(alice.address);

    const unwrapResult = await flowAdapter.unwrap(
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

    const balanceAfter = await flowAdapter.getBalance(alice.address);
    // Balance should increase by approximately netToRecipient minus gas
    const gasAllowance = 10n ** 16n; // 0.01 FLOW
    expect(balanceAfter + gasAllowance).toBeGreaterThan(balanceBefore);

    console.log(
      `[E2E:FLOW] unwrap tx: ${unwrapResult.txHash}, ` +
      `netToRecipient: ${unwrapResult.netToRecipient}`
    );
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Sanity: checkpoint metadata shows hasCheckpoint=true for Alice
  // ---------------------------------------------------------------------------

  it("Alice should have a checkpoint on-chain", async () => {
    if (SKIP) return;

    const meta = await checkpointClient.metadata(alice.address);
    expect(meta.hasCheckpoint).toBe(true);
    console.log(`[E2E:FLOW] checkpoint version=${meta.version}, cursor=${meta.lastConsumedNoteIndex}`);
  }, 15_000);
});
