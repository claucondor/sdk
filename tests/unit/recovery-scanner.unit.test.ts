/**
 * Unit tests for recovery/scanner.ts — default fromBlock behavior.
 *
 * Uses a minimal mock provider so no real RPC calls are made.
 */

import { describe, it, expect, vi } from "vitest";
import { scanJanusFlowSnapshots } from "../../src/recovery/scanner";
import type { ethers } from "ethers";

// Minimal mock provider that records getLogs calls.
function makeMockProvider(latestBlock: number) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(latestBlock),
    getLogs: vi.fn().mockResolvedValue([]),
  } as unknown as ethers.Provider;
}

describe("recovery/scanner — default fromBlock", () => {
  it("queries getBlockNumber and uses latestBlock-9000 when fromBlock is not provided", async () => {
    const latestBlock = 50_000;
    const provider = makeMockProvider(latestBlock);

    await scanJanusFlowSnapshots(
      "0x0000000000000000000000000000000000000001",
      provider,
      { janusFlowAddr: "0x0000000000000000000000000000000000000002" }
    );

    // getBlockNumber must have been called (to compute the default)
    const mock = provider as ReturnType<typeof makeMockProvider>;
    expect(mock.getBlockNumber).toHaveBeenCalledOnce();

    // All getLogs calls must use fromBlock = latestBlock - 9000 = 41000
    const expectedFrom = latestBlock - 9000; // 41000
    const getLogsCalls = mock.getLogs.mock.calls as Array<[{ fromBlock: number }]>;
    expect(getLogsCalls.length).toBeGreaterThan(0);
    for (const [filter] of getLogsCalls) {
      expect(filter.fromBlock).toBe(expectedFrom);
    }
  });

  it("clamps fromBlock to 0 when latestBlock < 9000", async () => {
    const latestBlock = 500;
    const provider = makeMockProvider(latestBlock);

    await scanJanusFlowSnapshots(
      "0x0000000000000000000000000000000000000001",
      provider,
      { janusFlowAddr: "0x0000000000000000000000000000000000000002" }
    );

    const mock = provider as ReturnType<typeof makeMockProvider>;
    const getLogsCalls = mock.getLogs.mock.calls as Array<[{ fromBlock: number }]>;
    for (const [filter] of getLogsCalls) {
      expect(filter.fromBlock).toBe(0);
    }
  });

  it("respects explicit fromBlock: 0 without calling getBlockNumber", async () => {
    const provider = makeMockProvider(99_999);

    await scanJanusFlowSnapshots(
      "0x0000000000000000000000000000000000000001",
      provider,
      {
        fromBlock: 0,
        janusFlowAddr: "0x0000000000000000000000000000000000000002",
      }
    );

    const mock = provider as ReturnType<typeof makeMockProvider>;
    // Explicit fromBlock means getBlockNumber should NOT be called
    expect(mock.getBlockNumber).not.toHaveBeenCalled();

    const getLogsCalls = mock.getLogs.mock.calls as Array<[{ fromBlock: number }]>;
    for (const [filter] of getLogsCalls) {
      expect(filter.fromBlock).toBe(0);
    }
  });

  it("respects explicit fromBlock: 12345 without calling getBlockNumber", async () => {
    const provider = makeMockProvider(99_999);

    await scanJanusFlowSnapshots(
      "0x0000000000000000000000000000000000000001",
      provider,
      {
        fromBlock: 12345,
        janusFlowAddr: "0x0000000000000000000000000000000000000002",
      }
    );

    const mock = provider as ReturnType<typeof makeMockProvider>;
    expect(mock.getBlockNumber).not.toHaveBeenCalled();

    const getLogsCalls = mock.getLogs.mock.calls as Array<[{ fromBlock: number }]>;
    for (const [filter] of getLogsCalls) {
      expect(filter.fromBlock).toBe(12345);
    }
  });

  it("returns empty array when no logs match", async () => {
    const provider = makeMockProvider(10_000);

    const results = await scanJanusFlowSnapshots(
      "0x0000000000000000000000000000000000000001",
      provider,
      { janusFlowAddr: "0x0000000000000000000000000000000000000002" }
    );

    expect(results).toEqual([]);
  });
});
