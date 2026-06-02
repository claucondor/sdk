/**
 * Integration tests: Token adapter implements the full JanusTokenAdapter interface
 * and returns the right shape for each of the 4 tokens.
 *
 * Requires: RUN_INTEGRATION=1 and access to Flow EVM testnet.
 *
 * These tests read on-chain state but do NOT submit transactions.
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll } from "vitest";
import { sdk } from "../../src/index";
import type { JanusTokenAdapter } from "../../src/adapters/JanusTokenAdapter";

const SKIP = !process.env.RUN_INTEGRATION;
const ALICE_EVM = "0x0000000000000000000000000000000000000001"; // dummy for read tests

describe.skipIf(SKIP)("token-adapter-contract — interface shape for all tokens", () => {
  const tokenIds = ["flow", "wflow", "mockusdc"] as const;

  for (const id of tokenIds) {
    describe(`token: ${id}`, () => {
      let adapter: JanusTokenAdapter;

      beforeAll(() => {
        adapter = sdk.token(id);
      });

      it("has correct id", () => {
        expect(adapter.id).toBe(id);
      });

      it("has non-empty address (0x prefixed, 42 chars)", () => {
        expect(adapter.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      });

      it("has correct variant", () => {
        if (id === "flow") expect(adapter.variant).toBe("native");
        else expect(adapter.variant).toBe("erc20");
      });

      it("feeBps() returns a number in [0, 100]", async () => {
        const bps = await adapter.feeBps();
        expect(typeof bps).toBe("number");
        expect(bps).toBeGreaterThanOrEqual(0);
        expect(bps).toBeLessThanOrEqual(100);
      }, 30000);

      it("feeRecipient() returns a 0x address", async () => {
        const addr = await adapter.feeRecipient();
        expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }, 30000);

      it("getCommitment(zeroAddr) returns identity point or valid point", async () => {
        const point = await adapter.getCommitment("0x0000000000000000000000000000000000000000");
        expect(typeof point.x).toBe("bigint");
        expect(typeof point.y).toBe("bigint");
      }, 30000);

      it("getFirstSnapshotBlock(zeroAddr) returns 0 for unknown address", async () => {
        const block = await adapter.getFirstSnapshotBlock("0x0000000000000000000000000000000000000000");
        expect(block).toBe(0n);
      }, 30000);

      it("getMemoKey(zeroAddr) returns null for unregistered address", async () => {
        const key = await adapter.getMemoKey("0x0000000000000000000000000000000000000000");
        expect(key).toBeNull();
      }, 30000);

      it("computeNet(100) returns <= 100 (fee deduction)", async () => {
        const net = await adapter.computeNet(100n);
        expect(net).toBeLessThanOrEqual(100n);
        expect(net).toBeGreaterThan(0n);
      }, 30000);
    });
  }
});

// mockft tests use Cadence — skip for now unless full setup
describe.skipIf(SKIP || !process.env.RUN_CADENCE_INTEGRATION)("token: mockft (Cadence FT)", () => {
  let adapter: JanusTokenAdapter;

  beforeAll(() => {
    adapter = sdk.token("mockft");
  });

  it("has variant cadence-ft", () => {
    expect(adapter.variant).toBe("cadence-ft");
  });

  it("has Cadence address format", () => {
    expect(adapter.address).toMatch(/^0x[0-9a-fA-F]{1,16}$/);
  });
});
