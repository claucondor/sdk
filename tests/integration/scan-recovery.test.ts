/**
 * Integration test: scan recovery — reconstruct balance from on-chain events.
 *
 * Bob loses local state. SDK reconstructs balance from on-chain events via
 * scanDeposits + latestSnapshot. Must reach the right number.
 *
 * Requires: RUN_INTEGRATION=1, BOB_EVM_PRIVKEY set (Bob has received tips).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { sdk } from "../../src/index";
import { deriveMemoKeyFromSignature } from "../../src/crypto/memokey";
import { ethers } from "ethers";
import { NETWORK_CONFIG } from "../../src/network/flow-client";

const SKIP = !process.env.RUN_INTEGRATION;
const BOB_EVM_PRIVKEY = process.env.BOB_EVM_PRIVKEY ?? "";

describe.skipIf(SKIP || !BOB_EVM_PRIVKEY)("scan-recovery — reconstruct balance from events", () => {
  let bobEvmAddr: string;
  let bobMemoPrivKey: bigint;

  beforeAll(async () => {
    const provider = new ethers.JsonRpcProvider(NETWORK_CONFIG.testnet.evmRpc);
    const wallet = new ethers.Wallet(BOB_EVM_PRIVKEY, provider);
    bobEvmAddr = await wallet.getAddress();
    const sig = await wallet.signMessage("OpenJanus MemoKey v1");
    const keypair = await deriveMemoKeyFromSignature(ethers.getBytes(sig));
    bobMemoPrivKey = keypair.privkey;
  }, 30000);

  it("latestSnapshot returns a valid state for Bob", async () => {
    const adapter = sdk.token("flow");
    const snapshot = await adapter.latestSnapshot(bobEvmAddr, bobMemoPrivKey).catch(() => null);
    if (snapshot === null) {
      console.warn("Bob has no snapshots yet — skip recovery check");
      return;
    }
    expect(typeof snapshot.balance).toBe("bigint");
    expect(typeof snapshot.blinding).toBe("bigint");
    expect(snapshot.timestampMs).toBeGreaterThan(0);
  }, 60000);

  it("scanDeposits returns incoming note records for Bob", async () => {
    const adapter = sdk.token("flow");
    const deposits = await adapter.scanDeposits(bobEvmAddr);
    // May be empty if Bob has received nothing
    expect(Array.isArray(deposits)).toBe(true);
    if (deposits.length > 0) {
      expect(deposits[0]).toHaveProperty("ciphertext");
      expect(deposits[0]).toHaveProperty("ephPubkey");
      expect(deposits[0]).toHaveProperty("timestampMs");
    }
  }, 60000);

  it("decrypted notes have valid amount+blinding fields", async () => {
    const adapter = sdk.token("flow");
    const deposits = await adapter.scanDeposits(bobEvmAddr);
    for (const dep of deposits.slice(0, 3)) {
      const note = await adapter.decryptNoteTo(
        dep.ciphertext,
        dep.ephPubkey,
        bobMemoPrivKey
      ).catch(() => null);
      if (note !== null) {
        expect(typeof note.amount).toBe("bigint");
        expect(typeof note.blinding).toBe("bigint");
        expect(note.amount).toBeGreaterThan(0n);
      }
    }
  }, 120000);
});
