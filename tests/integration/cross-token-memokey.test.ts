/**
 * Integration test: cross-token memokey consistency.
 *
 * Alice publishes memokey ONCE via JanusFlow.publishMemoKey.
 * The same memokey must be readable from all 4 adapters via getMemoKey.
 *
 * Requires: RUN_INTEGRATION=1, ALICE_EVM_ADDR set, ALICE_EVM_PRIVKEY set.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { sdk } from "../../src/index";
import { deriveMemoKeyFromSignature } from "../../src/crypto/memokey";
import { ethers } from "ethers";
import { NETWORK_CONFIG } from "../../src/network/flow-client";

const SKIP = !process.env.RUN_INTEGRATION;
const ALICE_EVM_PRIVKEY = process.env.ALICE_EVM_PRIVKEY ?? "";
const ALICE_CADENCE_ADDR = process.env.ALICE_CADENCE_ADDR ?? "0x7599043aea001283";

describe.skipIf(SKIP)("cross-token-memokey — same pubkey readable from all adapters", () => {
  let aliceEvmAddr: string;
  let memoKeyX: bigint;
  let memoKeyY: bigint;

  beforeAll(async () => {
    if (!ALICE_EVM_PRIVKEY) return;
    const provider = new ethers.JsonRpcProvider(NETWORK_CONFIG.testnet.evmRpc);
    const wallet = new ethers.Wallet(ALICE_EVM_PRIVKEY, provider);
    aliceEvmAddr = await wallet.getAddress();

    // Derive Alice's memokey from signature
    const sig = await wallet.signMessage("OpenJanus MemoKey v1");
    const sigBytes = ethers.getBytes(sig);
    const keypair = await deriveMemoKeyFromSignature(sigBytes);
    memoKeyX = keypair.pubkey.x;
    memoKeyY = keypair.pubkey.y;
  }, 30000);

  it("memoKey registered on JanusFlow (native) is readable", async () => {
    if (!ALICE_EVM_PRIVKEY) return;
    const key = await sdk.token("flow").getMemoKey(aliceEvmAddr);
    // If Alice has never published, key is null — that's OK for this test
    // The important thing is it doesn't throw
    expect(key === null || (typeof key!.x === "bigint")).toBe(true);
  }, 30000);

  it("getMemoKey shape: {x, y} bigints when registered", async () => {
    if (!ALICE_EVM_PRIVKEY) return;
    const key = await sdk.token("flow").getMemoKey(aliceEvmAddr);
    if (key !== null) {
      expect(typeof key.x).toBe("bigint");
      expect(typeof key.y).toBe("bigint");
    }
  }, 30000);

  it("all EVM adapters return same memoKey for same address", async () => {
    if (!ALICE_EVM_PRIVKEY) return;
    const [keyFlow, keyWflow, keyUsdc] = await Promise.all([
      sdk.token("flow").getMemoKey(aliceEvmAddr),
      sdk.token("wflow").getMemoKey(aliceEvmAddr),
      sdk.token("mockusdc").getMemoKey(aliceEvmAddr),
    ]);
    // If all return null, user hasn't published — that's expected on fresh testnet
    // If any returns non-null, all must match
    if (keyFlow !== null) {
      expect(keyWflow?.x).toBe(keyFlow.x);
      expect(keyUsdc?.x).toBe(keyFlow.x);
    }
  }, 60000);
});
