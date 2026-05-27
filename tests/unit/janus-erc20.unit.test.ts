/**
 * Unit tests for JanusERC20 v0.4 — no network required.
 *
 * Validates the concrete ERC20-wrapping class, constants, and ABI fragments
 * for the v0.4 deployment (proxy at 0xf2C04b1A32B815ac7Ffd87a4C312096592BBCa1e,
 * MockUSDC underlying at 0x3e8973dE565743Ef9748779bE377BBE050A13C22).
 */

import { describe, it, expect } from "vitest";
import {
  JanusERC20,
  JANUS_ERC20_TESTNET,
  JANUS_ERC20_EVM_ADDRESS,
  JANUS_ERC20_EVM_IMPL_ADDRESS,
  JANUS_ERC20_MOCK_USDC_ADDRESS,
  JANUS_ERC20_VERSION,
  JANUS_ERC20_MAX_WRAP_RAW,
  JANUS_ERC20_EXTRA_ABI,
  ERC20_MINIMAL_ABI,
} from "../../src/tokens/janus-erc20";

function isHexAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

describe("JanusERC20 v0.4 constants", () => {
  it("JANUS_ERC20_EVM_ADDRESS is a 40-char hex EVM address", () => {
    expect(isHexAddress(JANUS_ERC20_EVM_ADDRESS)).toBe(true);
  });

  it("JANUS_ERC20_EVM_IMPL_ADDRESS is a 40-char hex EVM address", () => {
    expect(isHexAddress(JANUS_ERC20_EVM_IMPL_ADDRESS)).toBe(true);
  });

  it("JANUS_ERC20_MOCK_USDC_ADDRESS is a 40-char hex EVM address", () => {
    expect(isHexAddress(JANUS_ERC20_MOCK_USDC_ADDRESS)).toBe(true);
  });

  it("proxy and impl addresses are distinct", () => {
    expect(JANUS_ERC20_EVM_ADDRESS.toLowerCase())
      .not.toBe(JANUS_ERC20_EVM_IMPL_ADDRESS.toLowerCase());
  });

  it("proxy and underlying addresses are distinct", () => {
    expect(JANUS_ERC20_EVM_ADDRESS.toLowerCase())
      .not.toBe(JANUS_ERC20_MOCK_USDC_ADDRESS.toLowerCase());
  });

  it("JANUS_ERC20_VERSION is '0.4.0'", () => {
    expect(JANUS_ERC20_VERSION).toBe("0.4.0");
  });

  it("JANUS_ERC20_MAX_WRAP_RAW is 2^64-ish (matches circuit range)", () => {
    expect(JANUS_ERC20_MAX_WRAP_RAW).toBe(18_000_000_000_000_000_000n);
  });

  it("JANUS_ERC20_TESTNET points at the proxy address", () => {
    expect(JANUS_ERC20_TESTNET.evmAddress).toBe(JANUS_ERC20_EVM_ADDRESS);
    expect(JANUS_ERC20_TESTNET.network).toBe("testnet");
  });
});

describe("JanusERC20 ABI fragments", () => {
  it("JANUS_ERC20_EXTRA_ABI includes wrap, unwrap, underlying, MAX_WRAP", () => {
    const joined = JANUS_ERC20_EXTRA_ABI.join("\n");
    expect(joined).toMatch(/function wrap\(uint256 amount, uint256\[2\]/);
    expect(joined).toMatch(/function unwrap\(uint256 claimedAmount/);
    expect(joined).toMatch(/function underlying\(\) view returns \(address\)/);
    expect(joined).toMatch(/function MAX_WRAP\(\) view returns \(uint256\)/);
  });

  it("ERC20_MINIMAL_ABI includes approve, transferFrom, balanceOf, allowance", () => {
    const joined = ERC20_MINIMAL_ABI.join("\n");
    expect(joined).toMatch(/function approve\(address spender, uint256 amount\)/);
    expect(joined).toMatch(/function transferFrom\(address from, address to, uint256 amount\)/);
    expect(joined).toMatch(/function balanceOf\(address account\)/);
    expect(joined).toMatch(/function allowance\(address owner, address spender\)/);
  });
});

describe("JanusERC20 class instantiation", () => {
  it("constructs with canonical testnet defaults", () => {
    const t = new JanusERC20();
    expect(t.address).toBe(JANUS_ERC20_EVM_ADDRESS);
  });

  it("accepts a partial override", () => {
    const t = new JanusERC20({ evmAddress: "0x1234567890123456789012345678901234567890" });
    expect(t.address).toBe("0x1234567890123456789012345678901234567890");
  });

  it("rejects invalid wrap amounts before sending tx", async () => {
    const t = new JanusERC20();
    // No signer connected — but argument validation runs first.
    await expect(
      t.wrap({
        amountRaw: 0n,
        txCommit: [1n, 2n],
        amountProof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n],
      })
    ).rejects.toThrow(/amountRaw must be > 0/);
  });

  it("rejects wrap amounts above MAX_WRAP", async () => {
    const t = new JanusERC20();
    await expect(
      t.wrap({
        amountRaw: JANUS_ERC20_MAX_WRAP_RAW + 1n,
        txCommit: [1n, 2n],
        amountProof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n],
      })
    ).rejects.toThrow(/exceeds MAX_WRAP/);
  });

  it("rejects wrong-length txCommit / amountProof in wrap", async () => {
    const t = new JanusERC20();
    await expect(
      // @ts-expect-error — wrong tuple length intentional
      t.wrap({ amountRaw: 1n, txCommit: [1n], amountProof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] })
    ).rejects.toThrow(/txCommit must be length 2/);
  });

  it("rejects wrong-length proof arrays in unwrap", async () => {
    const t = new JanusERC20();
    await expect(
      // @ts-expect-error — wrong length
      t.unwrap({
        claimedAmountRaw: 1n,
        recipient: "0x0000000000000000000000000000000000000001",
        txCommit: [1n, 2n],
        amountProof: [1n, 2n, 3n], // wrong
        transferPublicInputs: [1n, 2n, 3n, 4n, 5n, 6n],
        transferProof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n],
      })
    ).rejects.toThrow(/amountProof must be length 8/);
  });
});
