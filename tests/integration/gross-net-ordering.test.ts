/**
 * Integration test: gross-net ordering — the v0.5.6 bug class.
 *
 * For each EVM token: wrap GROSS amount. After wrap, verify on-chain
 * commitment binds to NET (re-compute Pedersen client-side and compare
 * to contract.balanceOfCommitment).
 *
 * This is the critical test that would have caught the v0.5.6/5.7 ordering bug.
 *
 * Requires: RUN_INTEGRATION=1, ALICE_EVM_PRIVKEY set, Alice has FLOW/WFLOW/mockUSDC.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { sdk } from "../../src/index";
import { deriveMemoKeyFromSignature } from "../../src/crypto/memokey";
import { computeCommitmentV05 as computeCommitment } from "../../src/primitives/pedersen";
import { computeNetWrap, computeWrapFee } from "../../src/crypto/fee-math";
import { ethers } from "ethers";
import { NETWORK_CONFIG } from "../../src/network/flow-client";

const SKIP = !process.env.RUN_INTEGRATION;
const ALICE_EVM_PRIVKEY = process.env.ALICE_EVM_PRIVKEY ?? "";

describe.skipIf(SKIP)("gross-net-ordering — on-chain commitment binds to NET", () => {
  let wallet: ethers.Wallet;
  let aliceEvmAddr: string;
  let memoPrivKey: bigint;

  beforeAll(async () => {
    if (!ALICE_EVM_PRIVKEY) return;
    const provider = new ethers.JsonRpcProvider(NETWORK_CONFIG.testnet.evmRpc);
    wallet = new ethers.Wallet(ALICE_EVM_PRIVKEY, provider);
    aliceEvmAddr = await wallet.getAddress();
    const sig = await wallet.signMessage("OpenJanus MemoKey v1");
    const keypair = await deriveMemoKeyFromSignature(ethers.getBytes(sig));
    memoPrivKey = keypair.privkey;
  }, 30000);

  for (const tokenId of ["flow", "wflow", "mockusdc"] as const) {
    it(`${tokenId}: commitment after wrap matches NET amount Pedersen`, async () => {
      if (!ALICE_EVM_PRIVKEY) return;

      const adapter = sdk.token(tokenId);
      const bps = await adapter.feeBps();
      const grossAmount = tokenId === "flow"
        ? 1_000_000_000_000_000_000n  // 1 FLOW
        : tokenId === "mockusdc"
        ? 1_000_000n                   // 1 USDC (6 dec)
        : 1_000_000_000_000_000_000n;  // 1 WFLOW

      // Check balance before
      const balBefore = await adapter.getBalance(aliceEvmAddr);
      if (balBefore < grossAmount) {
        console.warn(`Skipping ${tokenId}: insufficient balance`);
        return;
      }

      // Wrap
      const result = await adapter.wrap({ grossAmount }, wallet as unknown as import("ethers").Wallet);
      expect(result.txHash).toBeTruthy();
      expect(result.netAmount).toBe(computeNetWrap(grossAmount, bps));
      expect(result.fee).toBe(computeWrapFee(grossAmount, bps));

      // Read the stored snapshot to get blinding
      const snapshot = await adapter.latestSnapshot(aliceEvmAddr, memoPrivKey);
      expect(snapshot).toBeTruthy();

      // Recompute Pedersen commitment client-side for NET amount
      const clientCommit = await computeCommitment(snapshot.balance, snapshot.blinding);

      // Read on-chain commitment
      const onChainCommit = await adapter.getCommitment(aliceEvmAddr);

      // THE KEY ASSERTION: on-chain commit must match NET, not gross
      expect(onChainCommit.x).toBe(clientCommit.x);
      expect(onChainCommit.y).toBe(clientCommit.y);

      // Also verify balance in snapshot is NET
      expect(snapshot.balance).toBe(result.netAmount);
    }, 120000);
  }
});
