/**
 * Unit tests for recovery/scanner.ts — v0.5.4 firstSnapshotBlock hint.
 *
 * Uses a minimal mock provider so no real RPC calls are made.
 * The mock intercepts `call` for the firstSnapshotBlock hint and stubs
 * `getBlockNumber` + `getLogs` for the pagination path.
 */

import { describe, it, expect, vi } from "vitest";
import { scanJanusFlowSnapshots } from "../../src/recovery/scanner";
import { ethers } from "ethers";
import type { ethers as EthersNS } from "ethers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encode a uint256 as the 32-byte ABI-encoded return value of a view fn.
 * ethers.Contract decodes this into a bigint when the ABI says `uint256`.
 */
function encodeUint256(n: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [n]);
}

// firstSnapshotBlock(address) selector: keccak256("firstSnapshotBlock(address)")[0..4]
// Verified with: new ethers.Interface([...]).getFunction("firstSnapshotBlock").selector
const FSB_SELECTOR = "0x780c9f2e";

/**
 * Build a minimal mock provider that:
 *   - Stubs `call` to return ABI-encoded firstSnapshotBlock = firstBlock
 *     for any call whose data starts with the FSB selector.
 *   - Stubs `getBlockNumber` to return latestBlock.
 *   - Stubs `getLogs` to return [].
 *   - Stubs `getNetwork` (ethers.Contract needs it for contract instantiation).
 */
function makeMockProvider(latestBlock: number, firstBlock: bigint) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(latestBlock),
    getLogs: vi.fn().mockResolvedValue([]),
    call: vi.fn().mockImplementation(async (tx: { data?: string }) => {
      const data = (tx?.data ?? "").toLowerCase();
      if (data.startsWith(FSB_SELECTOR)) {
        return encodeUint256(firstBlock);
      }
      return "0x";
    }),
    getNetwork: vi.fn().mockResolvedValue({ chainId: 545n, name: "flow-evm-testnet" }),
    resolveName: vi.fn().mockResolvedValue(null),
    // ethers v6 AbstractProvider compatibility shims
    _isProvider: true,
    destroy: vi.fn(),
  } as unknown as EthersNS.Provider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recovery/scanner v0.5.4 — firstSnapshotBlock hint", () => {

  it("returns [] immediately when firstSnapshotBlock == 0 (user never interacted)", async () => {
    const provider = makeMockProvider(100_000, 0n);
    const mock = provider as ReturnType<typeof makeMockProvider>;

    const results = await scanJanusFlowSnapshots(
      "0x0000000000000000000000000000000000000001",
      provider,
      { janusFlowAddr: "0x0000000000000000000000000000000000000002" }
    );

    expect(results).toEqual([]);
    // call() was used to read the hint, but getLogs was NOT called
    expect(mock.call).toHaveBeenCalled();
    expect(mock.getLogs).not.toHaveBeenCalled();
  });

  it("paginates from firstSnapshotBlock when hint > 0", async () => {
    const firstBlock = 42_000;
    const latestBlock = 50_000;
    const provider = makeMockProvider(latestBlock, BigInt(firstBlock));
    const mock = provider as ReturnType<typeof makeMockProvider>;

    await scanJanusFlowSnapshots(
      "0x0000000000000000000000000000000000000001",
      provider,
      { janusFlowAddr: "0x0000000000000000000000000000000000000002" }
    );

    // getBlockNumber must have been called to bound the range
    expect(mock.getBlockNumber).toHaveBeenCalledOnce();

    // All getLogs calls must start at firstBlock (or within chunk windows from it)
    const getLogsCalls = mock.getLogs.mock.calls as Array<[{ fromBlock: number; toBlock: number }]>;
    expect(getLogsCalls.length).toBeGreaterThan(0);
    // First chunk starts at firstBlock
    expect(getLogsCalls[0][0].fromBlock).toBe(firstBlock);
    // No chunk may start before firstBlock
    for (const [filter] of getLogsCalls) {
      expect(filter.fromBlock).toBeGreaterThanOrEqual(firstBlock);
    }
  });

  it("uses a single chunk when range fits within 9000 blocks", async () => {
    const firstBlock = 49_000;
    const latestBlock = 50_000;
    const provider = makeMockProvider(latestBlock, BigInt(firstBlock));
    const mock = provider as ReturnType<typeof makeMockProvider>;

    await scanJanusFlowSnapshots(
      "0x0000000000000000000000000000000000000001",
      provider,
      { janusFlowAddr: "0x0000000000000000000000000000000000000002" }
    );

    // 4 event types × 1 chunk = 4 getLogs calls
    const getLogsCalls = mock.getLogs.mock.calls as Array<[{ fromBlock: number; toBlock: number }]>;
    expect(getLogsCalls.length).toBe(4);
    for (const [filter] of getLogsCalls) {
      expect(filter.fromBlock).toBe(firstBlock);
      expect(filter.toBlock).toBe(latestBlock);
    }
  });

  it("uses multiple chunks when range exceeds 9000 blocks", async () => {
    const firstBlock = 10_000;
    const latestBlock = 28_001; // 18002 blocks → 3 chunks (0-8999, 9000-17999, 18000+)
    const provider = makeMockProvider(latestBlock, BigInt(firstBlock));
    const mock = provider as ReturnType<typeof makeMockProvider>;

    await scanJanusFlowSnapshots(
      "0x0000000000000000000000000000000000000001",
      provider,
      { janusFlowAddr: "0x0000000000000000000000000000000000000002" }
    );

    const getLogsCalls = mock.getLogs.mock.calls as Array<[{ fromBlock: number; toBlock: number }]>;
    // 3 chunks × 4 event types = 12 calls
    expect(getLogsCalls.length).toBe(12);
    // First chunk starts at firstBlock
    expect(getLogsCalls[0][0].fromBlock).toBe(firstBlock);
    // Last chunk ends at latestBlock
    const lastCall = getLogsCalls[getLogsCalls.length - 1][0];
    expect(lastCall.toBlock).toBe(latestBlock);
  });

  it("respects explicit fromBlock: 0 — skips hint call, paginates from 0", async () => {
    // firstBlock = 999 but we override with explicit fromBlock: 0 — hint is ignored
    const provider = makeMockProvider(50_000, 999n);
    const mock = provider as ReturnType<typeof makeMockProvider>;

    await scanJanusFlowSnapshots(
      "0x0000000000000000000000000000000000000001",
      provider,
      {
        fromBlock: 0,
        janusFlowAddr: "0x0000000000000000000000000000000000000002",
      }
    );

    // call() should NOT have been hit with the FSB selector
    const fsbCalls = (mock.call.mock.calls as Array<[{ data?: string }]>).filter(
      ([tx]) => ((tx?.data ?? "").toLowerCase()).startsWith(FSB_SELECTOR)
    );
    expect(fsbCalls.length).toBe(0);

    // getLogs IS called (from block 0, explicit)
    const getLogsCalls = mock.getLogs.mock.calls as Array<[{ fromBlock: number }]>;
    expect(getLogsCalls.length).toBeGreaterThan(0);
    expect(getLogsCalls[0][0].fromBlock).toBe(0);
  });

  it("respects explicit fromBlock: 12345 — skips hint, paginates from 12345", async () => {
    const provider = makeMockProvider(50_000, 999n);
    const mock = provider as ReturnType<typeof makeMockProvider>;

    await scanJanusFlowSnapshots(
      "0x0000000000000000000000000000000000000001",
      provider,
      {
        fromBlock: 12345,
        janusFlowAddr: "0x0000000000000000000000000000000000000002",
      }
    );

    // Hint should not be queried
    const fsbCalls = (mock.call.mock.calls as Array<[{ data?: string }]>).filter(
      ([tx]) => ((tx?.data ?? "").toLowerCase()).startsWith(FSB_SELECTOR)
    );
    expect(fsbCalls.length).toBe(0);

    // First getLogs chunk starts at 12345
    const getLogsCalls = mock.getLogs.mock.calls as Array<[{ fromBlock: number }]>;
    expect(getLogsCalls.length).toBeGreaterThan(0);
    expect(getLogsCalls[0][0].fromBlock).toBe(12345);
  });

  it("returns empty array when no logs match even with hint > 0", async () => {
    const provider = makeMockProvider(50_000, 40_000n);

    const results = await scanJanusFlowSnapshots(
      "0x0000000000000000000000000000000000000001",
      provider,
      { janusFlowAddr: "0x0000000000000000000000000000000000000002" }
    );

    expect(results).toEqual([]);
  });
});
