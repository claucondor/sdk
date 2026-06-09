/**
 * tests/e2e/multi-token.test.ts
 *
 * Multi-token E2E test: Alice holds both FLOW and mUSDC shielded, sends FLOW to Bob
 * and mUSDC to Carol. Each recipient drains their isolated inbox independently.
 *
 * Exercises:
 *   - FLOW and mUSDC wrapped simultaneously in the same test suite
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
  orchestrateWrap,
} from "../../src/index";
import type { BabyJubKeypair } from "../../src/index";

const SKIP = process.env.RUN_E2E !== "1";

const WRAP_WITH_SNAPSHOT_SIG =
  "event WrapWithSnapshot(address indexed user, uint256 amount, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)";
const wrapIface = new ethers.Interface([WRAP_WITH_SNAPSHOT_SIG]);

/** Parse WrapWithSnapshot event from a tx hash and decrypt the snapshot. */
async function recoverBalanceAndBlinding(
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

// ERC20 mint calldata helper (ethers.Interface, not ethers.Contract)
const MINT_SIG  = "function mint(address to, uint256 amount)";
const mintIface = new ethers.Interface([MINT_SIG]);

describe("E2E: multi-token — FLOW to Bob, mUSDC to Carol", () => {
  const flowAdapter  = sdk.token("flow");
  const erc20Adapter = sdk.token("mockusdc");
  const inboxClient  = new ShieldedInboxClient();
  const provider     = makeProvider();

  let alice: ReturnType<typeof makeAlice>;
  let bob:   Awaited<ReturnType<typeof createFundedAccount>>;
  let carol: Awaited<ReturnType<typeof createFundedAccount>>;

  let aliceJub: BabyJubKeypair;
  let bobJub:   BabyJubKeypair;
  let carolJub: BabyJubKeypair;

  let aliceFlowBalance:   bigint;
  let aliceFlowBlinding:  bigint;
  let aliceMusdcBalance:  bigint;
  let aliceMusdcBlinding: bigint;

  const FLOW_TRANSFER  = AMOUNTS.POINT3_FLOW;  // FLOW to Bob
  const MUSDC_TRANSFER = AMOUNTS.THREE_MUSDC;  // mUSDC to Carol

  beforeAll(async () => {
    if (SKIP) return;
    skipIfNotE2E();

    alice = makeAlice();
    bob   = await createFundedAccount("0.1");
    carol = await createFundedAccount("0.05");

    aliceJub = await deriveMemoJub(alice.address, "e2e-multi:alice:v1");
    bobJub   = await deriveMemoJub(bob.address,   "e2e-multi:bob:v1");
    carolJub = await deriveMemoJub(carol.address,  "e2e-multi:carol:v1");

    // Publish memokeys for all three via their respective token adapters
    // Alice uses both FLOW and mUSDC adapters (same registry, one key covers all)
    const aliceKeyFlow = await flowAdapter.getMemoKey(alice.address);
    if (!aliceKeyFlow) {
      await flowAdapter.publishMemoKey(aliceJub, alice);
    } else if (aliceKeyFlow.x !== aliceJub.pubkey.x || aliceKeyFlow.y !== aliceJub.pubkey.y) {
      await flowAdapter.rotateMemoKey(aliceJub, alice);
    }

    const bobKey = await flowAdapter.getMemoKey(bob.address);
    if (!bobKey) await flowAdapter.publishMemoKey(bobJub, bob.wallet);

    const carolKey = await erc20Adapter.getMemoKey(carol.address);
    if (!carolKey) await erc20Adapter.publishMemoKey(carolJub, carol.wallet);

    // Pre-drain inboxes
    for (const { wallet, address } of [bob, carol]) {
      const n = await inboxClient.count(address);
      if (n > 0n) await inboxClient.drainAll(wallet);
    }

    // Mint mUSDC for Alice
    const mintCalldata = mintIface.encodeFunctionData("mint", [
      alice.address,
      AMOUNTS.HUNDRED_MUSDC,
    ]);
    const mintTx = await alice.sendTransaction({ to: ADDRESSES.mockUSDC, data: mintCalldata });
    await mintTx.wait(1);
    console.log(`[E2E:multi] mint mUSDC tx: ${mintTx.hash}`);

    // Approve mUSDC for JanusERC20
    await (erc20Adapter as any).approveUnderlying(AMOUNTS.TEN_MUSDC, alice);

    console.log(`[E2E:multi] Alice: ${alice.address}`);
    console.log(`[E2E:multi] Bob:   ${bob.address}`);
    console.log(`[E2E:multi] Carol: ${carol.address}`);
  }, 180_000);

  // ---------------------------------------------------------------------------
  // Step 1 — Alice wraps 1 FLOW + 10 mUSDC simultaneously
  // ---------------------------------------------------------------------------

  it("should wrap 1 FLOW for Alice", async () => {
    if (SKIP) return;

    const result = await flowAdapter.wrap({ grossAmount: AMOUNTS.ONE_FLOW }, alice);
    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    console.log(`[E2E:multi] FLOW wrap tx: ${result.txHash}`);

    const { balance, blinding } = await recoverBalanceAndBlinding(
      result.txHash, flowAdapter, aliceJub.privkey, provider
    );
    aliceFlowBalance  = balance;
    aliceFlowBlinding = blinding;
    expect(aliceFlowBalance).toBe(result.netAmount);
    console.log(`[E2E:multi] Alice FLOW shielded: ${aliceFlowBalance}`);
  }, 120_000);

  it("should wrap 10 mUSDC for Alice", async () => {
    if (SKIP) return;

    const result = await erc20Adapter.wrap({ grossAmount: AMOUNTS.TEN_MUSDC }, alice);
    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    console.log(`[E2E:multi] mUSDC wrap tx: ${result.txHash}`);

    const { balance, blinding } = await recoverBalanceAndBlinding(
      result.txHash, erc20Adapter, aliceJub.privkey, provider
    );
    aliceMusdcBalance  = balance;
    aliceMusdcBlinding = blinding;
    expect(aliceMusdcBalance).toBe(result.netAmount);
    console.log(`[E2E:multi] Alice mUSDC shielded: ${aliceMusdcBalance}`);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Step 2 — Alice sends FLOW to Bob, mUSDC to Carol (concurrently via SDK)
  // ---------------------------------------------------------------------------

  it("should shieldedTransfer FLOW to Bob and mUSDC to Carol", async () => {
    if (SKIP) return;

    // Transfer FLOW to Bob
    const flowSend = await flowAdapter.shieldedTransfer(
      {
        recipient:       bob.address,
        amount:          FLOW_TRANSFER,
        memo:            "multi-token-flow-to-bob",
        currentBalance:  aliceFlowBalance,
        currentBlinding: aliceFlowBlinding,
      },
      alice,
    );
    expect(flowSend.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    aliceFlowBalance  = flowSend.newBalance!;
    aliceFlowBlinding = flowSend.newBlinding!;
    console.log(`[E2E:multi] FLOW→Bob tx: ${flowSend.txHash}`);

    // Transfer mUSDC to Carol
    const musdcSend = await erc20Adapter.shieldedTransfer(
      {
        recipient:       carol.address,
        amount:          MUSDC_TRANSFER,
        memo:            "multi-token-musdc-to-carol",
        currentBalance:  aliceMusdcBalance,
        currentBlinding: aliceMusdcBlinding,
      },
      alice,
    );
    expect(musdcSend.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    aliceMusdcBalance  = musdcSend.newBalance!;
    aliceMusdcBlinding = musdcSend.newBlinding!;
    console.log(`[E2E:multi] mUSDC→Carol tx: ${musdcSend.txHash}`);

    // Bob should have a FLOW note, Carol should have a mUSDC note
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
  // Sanity — Bob should have NO mUSDC notes, Carol should have NO FLOW notes
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
