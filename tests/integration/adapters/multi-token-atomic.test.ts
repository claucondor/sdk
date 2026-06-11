/**
 * tests/integration/adapters/multi-token-atomic.test.ts
 *
 * Integration stub for multi-token atomic wrap tests.
 * Validates that the new ERC20 and FT atomic templates produce well-formed
 * Cadence transactions that can be submitted to Flow testnet.
 *
 * Gated by: FLOW_TESTNET_INTEGRATION=1
 *
 * This test is a stub — it covers template generation under real addresses
 * and will be expanded to full on-chain submission once the atomic adapter
 * methods are wired up in tip-actions.ts.
 *
 * To run:
 *   FLOW_TESTNET_INTEGRATION=1 npx vitest run tests/integration/adapters/multi-token-atomic.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  wrapErc20Atomic,
  sendTipErc20Atomic,
  unwrapErc20Atomic,
  wrapFtAtomic,
  sendTipFtAtomic,
  unwrapFtAtomic,
  claimBatchFtAtomic,
} from "../../../src/cadence/index";
import {
  TOKEN_REGISTRY,
  SHIELDED_CHECKPOINT_ADDRESS,
} from "../../../src/network/contracts";

const SKIP = !process.env.FLOW_TESTNET_INTEGRATION;

// FT token identifier: Cadence deployer zero-padded to 20 bytes
const FT_TOKEN_ID = `0x0000000000000000000000004b6bc58bc8bf5dcc`;
const FT_CONTRACT_ADDR = "0x4b6bc58bc8bf5dcc";
const FT_CONTRACT_NAME = "MockFT";
const FT_ADDRESS = "0x4b6bc58bc8bf5dcc";

describe.skipIf(SKIP)("multi-token atomic — template validity under real addresses", () => {
  beforeAll(() => {
    if (SKIP) return;
    console.log("Running against Flow testnet. SHIELDED_CHECKPOINT_ADDRESS:", SHIELDED_CHECKPOINT_ADDRESS);
  });

  describe("ERC20 atomic templates with real mUSDC addresses", () => {
    const proxy = TOKEN_REGISTRY.mockusdc.proxy;
    const underlying = TOKEN_REGISTRY.mockusdc.underlying;

    it("wrapErc20Atomic generates non-empty template with real proxy", () => {
      const tx = wrapErc20Atomic(proxy);
      expect(tx.length).toBeGreaterThan(500);
      expect(tx).toContain(proxy);
      expect(tx).toContain(SHIELDED_CHECKPOINT_ADDRESS);
      expect(tx).toContain("EVM.EVMBytes(value:");
    });

    it("sendTipErc20Atomic generates non-empty template with real proxy", () => {
      const tx = sendTipErc20Atomic(proxy);
      expect(tx.length).toBeGreaterThan(400);
      expect(tx).toContain(proxy);
      expect(tx).toContain(SHIELDED_CHECKPOINT_ADDRESS);
    });

    it("unwrapErc20Atomic generates non-empty template with real proxy", () => {
      const tx = unwrapErc20Atomic(proxy);
      expect(tx.length).toBeGreaterThan(400);
      expect(tx).toContain(proxy);
      expect(tx).toContain(SHIELDED_CHECKPOINT_ADDRESS);
    });

    it("wrapErc20Atomic template contains underlying address as runtime arg placeholder (not baked)", () => {
      // underlying is passed as `underlyingHex` at runtime, not baked into the template
      const tx = wrapErc20Atomic(proxy);
      expect(tx).toContain("underlyingHex: String");
      // The underlying address itself should NOT appear baked in the template
      expect(tx).not.toContain(underlying);
    });
  });

  describe("FT atomic templates with real JanusFT addresses", () => {
    it("wrapFtAtomic generates non-empty template with real contract addresses", () => {
      const tx = wrapFtAtomic(FT_TOKEN_ID, FT_CONTRACT_ADDR, FT_CONTRACT_NAME, FT_ADDRESS);
      expect(tx.length).toBeGreaterThan(800);
      expect(tx).toContain(FT_CONTRACT_ADDR);
      expect(tx).toContain(FT_TOKEN_ID);
      expect(tx).toContain(SHIELDED_CHECKPOINT_ADDRESS);
    });

    it("sendTipFtAtomic generates non-empty template with real contract address", () => {
      const tx = sendTipFtAtomic(FT_TOKEN_ID, FT_CONTRACT_ADDR);
      expect(tx.length).toBeGreaterThan(600);
      expect(tx).toContain(FT_CONTRACT_ADDR);
      expect(tx).toContain(FT_TOKEN_ID);
    });

    it("claimBatchFtAtomic generates non-empty template with real contract address", () => {
      const tx = claimBatchFtAtomic(FT_TOKEN_ID, FT_CONTRACT_ADDR);
      expect(tx.length).toBeGreaterThan(500);
      expect(tx).toContain(FT_CONTRACT_ADDR);
      expect(tx).toContain(SHIELDED_CHECKPOINT_ADDRESS);
    });
  });

  describe("atomic template completeness — all 7 new templates callable", () => {
    it("all 7 new atomic templates return strings", () => {
      expect(typeof wrapErc20Atomic(TOKEN_REGISTRY.mockusdc.proxy)).toBe("string");
      expect(typeof sendTipErc20Atomic(TOKEN_REGISTRY.mockusdc.proxy)).toBe("string");
      expect(typeof unwrapErc20Atomic(TOKEN_REGISTRY.mockusdc.proxy)).toBe("string");
      expect(typeof wrapFtAtomic(FT_TOKEN_ID, FT_CONTRACT_ADDR, FT_CONTRACT_NAME, FT_ADDRESS)).toBe("string");
      expect(typeof sendTipFtAtomic(FT_TOKEN_ID, FT_CONTRACT_ADDR)).toBe("string");
      expect(typeof unwrapFtAtomic(FT_TOKEN_ID, FT_CONTRACT_ADDR, FT_CONTRACT_NAME, FT_ADDRESS)).toBe("string");
      expect(typeof claimBatchFtAtomic(FT_TOKEN_ID, FT_CONTRACT_ADDR)).toBe("string");
    });
  });
});

// Smoke test always runs (no network needed) — template shape only
describe("multi-token atomic — smoke (no network)", () => {
  it("all 7 new templates are non-empty strings", () => {
    const proxy = "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d";
    expect(wrapErc20Atomic(proxy).length).toBeGreaterThan(100);
    expect(sendTipErc20Atomic(proxy).length).toBeGreaterThan(100);
    expect(unwrapErc20Atomic(proxy).length).toBeGreaterThan(100);
    expect(wrapFtAtomic(FT_TOKEN_ID, FT_CONTRACT_ADDR, FT_CONTRACT_NAME, FT_ADDRESS).length).toBeGreaterThan(100);
    expect(sendTipFtAtomic(FT_TOKEN_ID, FT_CONTRACT_ADDR).length).toBeGreaterThan(100);
    expect(unwrapFtAtomic(FT_TOKEN_ID, FT_CONTRACT_ADDR, FT_CONTRACT_NAME, FT_ADDRESS).length).toBeGreaterThan(100);
    expect(claimBatchFtAtomic(FT_TOKEN_ID, FT_CONTRACT_ADDR).length).toBeGreaterThan(100);
  });
});
