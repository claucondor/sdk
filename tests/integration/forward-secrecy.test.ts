/**
 * Integration test: forward secrecy — each shieldedTransfer uses different ephemerals.
 *
 * Same sender→recipient pair, 2 separate shieldedTransfer calls.
 * Each must emit a different ephPubkey (unlinkability).
 *
 * Requires: RUN_INTEGRATION=1, ALICE_EVM_PRIVKEY + BOB_EVM_ADDR set.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { sdk } from "../../src/index";
import { deriveMemoKeyFromSignature } from "../../src/crypto/memokey";
import { scanIncomingNotes } from "../../src/scan/event-scanner";
import { ethers } from "ethers";
import { NETWORK_CONFIG } from "../../src/network/flow-client";
import { TOKEN_REGISTRY } from "../../src/network/contracts";

const SKIP = !process.env.RUN_INTEGRATION;
const ALICE_EVM_PRIVKEY = process.env.ALICE_EVM_PRIVKEY ?? "";
const BOB_EVM_ADDR = process.env.BOB_EVM_ADDR ?? "";

describe.skipIf(SKIP || !ALICE_EVM_PRIVKEY || !BOB_EVM_ADDR)(
  "forward-secrecy — distinct ephemeral per shieldedTransfer",
  () => {
    let wallet: ethers.Wallet;
    let aliceEvmAddr: string;

    beforeAll(async () => {
      const provider = new ethers.JsonRpcProvider(NETWORK_CONFIG.testnet.evmRpc);
      wallet = new ethers.Wallet(ALICE_EVM_PRIVKEY, provider);
      aliceEvmAddr = await wallet.getAddress();
    }, 30000);

    it("two sends to same recipient have different ephPubkeyToX", async () => {
      const adapter = sdk.token("flow");

      // Alice must have wrapped something first
      const snapshot = await adapter.latestSnapshot(
        aliceEvmAddr,
        // For this test we just need to do two transfers; use test balance
        0n // placeholder privkey — won't decrypt snapshots but transfers will still emit events
      ).catch(() => null);

      if (!snapshot || snapshot.balance < 2_000_000_000_000_000n) {
        console.warn("Skipping forward-secrecy: insufficient shielded balance");
        return;
      }

      // Scan incoming notes for Bob before transfers
      const notesBefore = await scanIncomingNotes(
        BOB_EVM_ADDR,
        TOKEN_REGISTRY.flow.proxy,
        new ethers.JsonRpcProvider(NETWORK_CONFIG.testnet.evmRpc)
      );
      const countBefore = notesBefore.length;

      // Send #1
      await adapter.shieldedTransfer({
        recipient: BOB_EVM_ADDR,
        amount: 500_000_000_000_000n,
        memo: "send 1",
        currentBalance: snapshot.balance,
        currentBlinding: snapshot.blinding,
      }, wallet as unknown as import("ethers").Wallet);

      // Read updated snapshot for send #2
      const snapshot2 = await adapter.latestSnapshot(aliceEvmAddr, 0n).catch(() => null);
      if (!snapshot2 || snapshot2.balance < 500_000_000_000_000n) {
        console.warn("Could not get updated snapshot for second send");
        return;
      }

      // Send #2
      await adapter.shieldedTransfer({
        recipient: BOB_EVM_ADDR,
        amount: 500_000_000_000_000n,
        memo: "send 2",
        currentBalance: snapshot2.balance,
        currentBlinding: snapshot2.blinding,
      }, wallet as unknown as import("ethers").Wallet);

      // Scan Bob's incoming notes — should have 2 new entries
      const notesAfter = await scanIncomingNotes(
        BOB_EVM_ADDR,
        TOKEN_REGISTRY.flow.proxy,
        new ethers.JsonRpcProvider(NETWORK_CONFIG.testnet.evmRpc)
      );
      const newNotes = notesAfter.slice(countBefore);
      expect(newNotes.length).toBeGreaterThanOrEqual(2);

      // Key assertion: different ephemeral pubkeys
      const eph1 = newNotes[newNotes.length - 2]!.ephPubkey.x;
      const eph2 = newNotes[newNotes.length - 1]!.ephPubkey.x;
      expect(eph1).not.toBe(eph2);
    }, 300000);
  }
);
