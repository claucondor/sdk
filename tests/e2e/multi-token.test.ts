/**
 * tests/e2e/multi-token.test.ts
 *
 * Multi-token E2E test: fresh sender holds both FLOW and mUSDC shielded, sends FLOW to Bob
 * and mUSDC to Carol. Each recipient drains their isolated inbox independently.
 *
 * Uses ONE fresh sender account for BOTH FLOW and mUSDC operations.
 * FLOW and mUSDC commitments are on separate contracts so there's no state collision.
 * The deployer (Alice) only mints mUSDC and funds fresh accounts.
 *
 * Exercises:
 *   - FLOW and mUSDC wrapped by the same fresh sender
 *   - Bob and Carol have separate random EOA wallets
 *   - Inbox note.depositor field used to verify token-type disambiguation
 *   - Two simultaneous recipients drain their respective isolated inboxes
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
import type { BabyJubKeypair } from "../../src/index";

const SKIP = process.env.RUN_E2E !== "1";

const WRAP_WITH_SNAPSHOT_SIG =
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)";
const wrapIface = new ethers.Interface([WRAP_WITH_SNAPSHOT_SIG]);

// ERC20 mint calldata helper (ethers.Interface, not ethers.Contract)
const MINT_SIG  = "function mint(address to, uint256 amount)";
const mintIface = new ethers.Interface([MINT_SIG]);

/** Parse WrapWithSnapshot event from a tx hash and decrypt the snapshot. */
async function recoverBlinding(
  txHash: string,
  adapter: ReturnType<typeof sdk.token>,
  privkey: bigint,
  provider: ethers.JsonRpcProvider,
): Promise<{ balance: bigint; blinding: bigint }> {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`No receipt for ${txHash}`);

  for (const log of receipt.logs) {
    try {
      const parsed = wrapIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "WrapWithSnapshot") {
        const encBytes = ethers.getBytes(parsed.args.encryptedSnapshot);
        const ephX     = BigInt(parsed.args.ephPubkeyX);
        const ephY     = BigInt(parsed.args.ephPubkeyY);
        const snap = await adapter.decryptSnapshot(encBytes, { x: ephX, y: ephY }, privkey);
        return { balance: snap.balance, blinding: snap.blinding };
      }
    } catch {
      // Not this event
    }
  }
  throw new Error(`WrapWithSnapshot event not found in tx ${txHash}`);
}

describe("E2E: multi-token — FLOW to Bob, mUSDC to Carol", () => {
  const flowAdapter  = sdk.token("flow");
  const erc20Adapter = sdk.token("mockusdc");
  const inboxClient  = new ShieldedInboxClient();
  const provider     = makeProvider();

  // Fresh sender for both FLOW and mUSDC operations (separate contracts — no state collision)
  let sender: Awaited<ReturnType<typeof createFundedAccount>>;
  let bob:    Awaited<ReturnType<typeof createFundedAccount>>;
  let carol:  Awaited<ReturnType<typeof createFundedAccount>>;

  let senderJub: BabyJubKeypair;
  let bobJub:    BabyJubKeypair;
  let carolJub:  BabyJubKeypair;

  let senderFlowBalance:   bigint;
  let senderFlowBlinding:  bigint;
  let senderMusdcBalance:  bigint;
  let senderMusdcBlinding: bigint;

  // Small amounts to stay within testnet budget
  const FLOW_WRAP_AMOUNT = 2n * 10n ** 16n;       // 0.02 FLOW gross wrap
  const FLOW_TRANSFER    = 5n * 10n ** 15n;        // 0.005 FLOW to Bob
  const MUSDC_WRAP       = AMOUNTS.TEN_MUSDC;     // 10 mUSDC
  const MUSDC_TRANSFER   = AMOUNTS.THREE_MUSDC;   // 3 mUSDC to Carol

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotE2E();

    const alice = makeAlice(); // deployer — funding and minting only
    sender = await createFundedAccount("0.08"); // gas for 7 txs + FLOW wrap (recovered negligible)
    bob    = await createFundedAccount("0.005");
    carol  = await createFundedAccount("0.005");

    senderJub = await deriveMemoJub(sender.address, "e2e-multi:sender:v1");
    bobJub    = await deriveMemoJub(bob.address,    "e2e-multi:bob:v1");
    carolJub  = await deriveMemoJub(carol.address,  "e2e-multi:carol:v1");

    // Publish memokeys for sender via FLOW adapter (same registry, works for both tokens)
    const senderKey = await flowAdapter.getMemoKey(sender.address);
    if (!senderKey) {
      await flowAdapter.publishMemoKey(senderJub, sender.wallet);
    } else if (senderKey.x !== senderJub.pubkey.x || senderKey.y !== senderJub.pubkey.y) {
      await flowAdapter.rotateMemoKey(senderJub, sender.wallet);
    }

    // Publish memokeys for Bob and Carol
    const bobKey = await flowAdapter.getMemoKey(bob.address);
    if (!bobKey) await flowAdapter.publishMemoKey(bobJub, bob.wallet);

    const carolKey = await erc20Adapter.getMemoKey(carol.address);
    if (!carolKey) await erc20Adapter.publishMemoKey(carolJub, carol.wallet);

    // Pre-drain inboxes
    for (const { wallet, address } of [bob, carol]) {
      const n = await inboxClient.count(address);
      if (n > 0n) await inboxClient.drainAll(wallet);
    }

    // Mint mUSDC to fresh sender + approve (deployer only for minting)
    const mintCalldata = mintIface.encodeFunctionData("mint", [
      sender.address,
      AMOUNTS.HUNDRED_MUSDC,
    ]);
    const mintTx = await alice.sendTransaction({ to: ADDRESSES.mockUSDC, data: mintCalldata });
    await mintTx.wait(1);
    console.log(`[E2E:multi] mint mUSDC tx: ${mintTx.hash}`);

    // Approve mUSDC for JanusERC20 via adapter
    await (erc20Adapter as any).approveUnderlying(MUSDC_WRAP, sender.wallet);

    console.log(`[E2E:multi] Sender (fresh): ${sender.address}`);
    console.log(`[E2E:multi] Bob:            ${bob.address}`);
    console.log(`[E2E:multi] Carol:          ${carol.address}`);
  }, 180_000);

  // ---------------------------------------------------------------------------
  // Step 1a — Sender wraps FLOW
  // ---------------------------------------------------------------------------

  it("should wrap FLOW for sender", async () => {
    if (SKIP) return;

    const result = await flowAdapter.wrap({ grossAmount: FLOW_WRAP_AMOUNT }, sender.wallet);
    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    console.log(`[E2E:multi] FLOW wrap tx: ${result.txHash}`);

    const { balance, blinding } = await recoverBlinding(
      result.txHash, flowAdapter, senderJub.privkey, provider
    );
    senderFlowBalance  = balance;
    senderFlowBlinding = blinding;
    expect(senderFlowBalance).toBe(result.netAmount);
    console.log(`[E2E:multi] Sender FLOW shielded: ${senderFlowBalance}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 1b — Sender wraps mUSDC
  // ---------------------------------------------------------------------------

  it("should wrap mUSDC for sender", async () => {
    if (SKIP) return;

    const result = await erc20Adapter.wrap({ grossAmount: MUSDC_WRAP }, sender.wallet);
    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    console.log(`[E2E:multi] mUSDC wrap tx: ${result.txHash}`);

    const { balance, blinding } = await recoverBlinding(
      result.txHash, erc20Adapter, senderJub.privkey, provider
    );
    senderMusdcBalance  = balance;
    senderMusdcBlinding = blinding;
    expect(senderMusdcBalance).toBe(result.netAmount);
    console.log(`[E2E:multi] Sender mUSDC shielded: ${senderMusdcBalance}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 2 — Sender transfers FLOW to Bob and mUSDC to Carol
  // ---------------------------------------------------------------------------

  it("should shieldedTransfer FLOW to Bob and mUSDC to Carol", async () => {
    if (SKIP) return;

    // Transfer FLOW to Bob
    const flowSend = await flowAdapter.shieldedTransfer(
      {
        recipient:       bob.address,
        amount:          FLOW_TRANSFER,
        memo:            "multi-token-flow-to-bob",
        currentBalance:  senderFlowBalance,
        currentBlinding: senderFlowBlinding,
      },
      sender.wallet,
    );
    expect(flowSend.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    senderFlowBalance  = flowSend.newBalance!;
    senderFlowBlinding = flowSend.newBlinding!;
    console.log(`[E2E:multi] FLOW→Bob tx: ${flowSend.txHash}`);

    // Transfer mUSDC to Carol
    const musdcSend = await erc20Adapter.shieldedTransfer(
      {
        recipient:       carol.address,
        amount:          MUSDC_TRANSFER,
        memo:            "multi-token-musdc-to-carol",
        currentBalance:  senderMusdcBalance,
        currentBlinding: senderMusdcBlinding,
      },
      sender.wallet,
    );
    expect(musdcSend.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    senderMusdcBalance  = musdcSend.newBalance!;
    senderMusdcBlinding = musdcSend.newBlinding!;
    console.log(`[E2E:multi] mUSDC→Carol tx: ${musdcSend.txHash}`);

    // Verify both inboxes have notes
    const [bobCount, carolCount] = await Promise.all([
      inboxClient.count(bob.address),
      inboxClient.count(carol.address),
    ]);
    expect(bobCount).toBeGreaterThanOrEqual(1n);
    expect(carolCount).toBeGreaterThanOrEqual(1n);
    console.log(`[E2E:multi] Bob inbox: ${bobCount}, Carol inbox: ${carolCount}`);
  }, 180_000);

  // ---------------------------------------------------------------------------
  // Step 3 — Bob drains his isolated FLOW inbox
  // ---------------------------------------------------------------------------

  it("should drain Bob's inbox — only FLOW note present", async () => {
    if (SKIP) return;

    const { decrypted, failed, txHash } =
      await inboxClient.drainAndDecrypt(bob.wallet, bobJub.privkey);

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(decrypted.length).toBeGreaterThan(0);
    expect(failed.length).toBe(0);

    // All notes in Bob's inbox should be from JanusFlow proxy
    for (const d of decrypted) {
      expect(d.note.depositor.toLowerCase()).toBe(ADDRESSES.janusFlow.toLowerCase());
    }

    const decoded = decrypted[0].content;
    expect(decoded.amount).toBe(FLOW_TRANSFER);
    expect(decoded.memo).toBe("multi-token-flow-to-bob");
    console.log(`[E2E:multi] Bob drained FLOW tx: ${txHash}, amount: ${decoded.amount}`);
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Step 4 — Carol drains her isolated mUSDC inbox
  // ---------------------------------------------------------------------------

  it("should drain Carol's inbox — only mUSDC note present", async () => {
    if (SKIP) return;

    const { decrypted, failed, txHash } =
      await inboxClient.drainAndDecrypt(carol.wallet, carolJub.privkey);

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(decrypted.length).toBeGreaterThan(0);
    expect(failed.length).toBe(0);

    // All notes in Carol's inbox should be from JanusERC20 proxy
    for (const d of decrypted) {
      expect(d.note.depositor.toLowerCase()).toBe(ADDRESSES.janusERC20.toLowerCase());
    }

    const decoded = decrypted[0].content;
    expect(decoded.amount).toBe(MUSDC_TRANSFER);
    expect(decoded.memo).toBe("multi-token-musdc-to-carol");
    console.log(`[E2E:multi] Carol drained mUSDC tx: ${txHash}, amount: ${decoded.amount}`);
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Sanity — inboxes fully drained after operations
  // ---------------------------------------------------------------------------

  it("Bob and Carol inboxes should be fully drained", async () => {
    if (SKIP) return;

    const [bobCount, carolCount] = await Promise.all([
      inboxClient.count(bob.address),
      inboxClient.count(carol.address),
    ]);
    expect(bobCount).toBe(0n);
    expect(carolCount).toBe(0n);
    console.log(`[E2E:multi] post-drain: Bob=${bobCount}, Carol=${carolCount}`);
  }, 30_000);
});
