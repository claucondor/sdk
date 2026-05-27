/**
 * Unit tests for JanusToken v0.3 — no network required.
 *
 * Validates the abstract base API surface: addresses, ABI, class shape, and
 * connection guards. State-changing flows are exercised via the JanusFlow
 * concrete subclass tests + integration suite.
 */

import { describe, it, expect } from "vitest";
import {
  JanusToken,
  JANUS_BABYJUB_ADDRESS,
  AMOUNT_DISCLOSE_VERIFIER,
  CONFIDENTIAL_TRANSFER_VERIFIER,
  JANUS_TOKEN_OWNER_EVM,
  JANUS_TOKEN_BASE_ABI,
  JANUS_TOKEN_DEPRECATED_ADDRESSES,
} from "../../src/tokens/janus-token";
import {
  JANUS_FLOW_TESTNET,
  JANUS_FLOW_EVM_ADDRESS,
} from "../../src/tokens/janus-flow";

// ---------------------------------------------------------------------------
// Address format helpers
// ---------------------------------------------------------------------------

function isHexAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

// ---------------------------------------------------------------------------
// Canonical v0.3 address assertions
// ---------------------------------------------------------------------------

describe("v0.3 canonical addresses", () => {
  it("JANUS_FLOW_EVM_ADDRESS is the v0.3 proxy", () => {
    expect(JANUS_FLOW_EVM_ADDRESS).toBe("0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078");
    expect(isHexAddress(JANUS_FLOW_EVM_ADDRESS)).toBe(true);
  });

  it("JANUS_BABYJUB_ADDRESS is the canonical BabyJub.sol", () => {
    expect(JANUS_BABYJUB_ADDRESS).toBe("0x27139AFda7425f51F68D32e0A38b7D43BcB0f870");
    expect(isHexAddress(JANUS_BABYJUB_ADDRESS)).toBe(true);
  });

  it("AMOUNT_DISCLOSE_VERIFIER is the v0.3 ceremony-backed verifier", () => {
    expect(AMOUNT_DISCLOSE_VERIFIER).toBe("0xD0ED3936530258C278f5357C1dB709ad34768352");
    expect(isHexAddress(AMOUNT_DISCLOSE_VERIFIER)).toBe(true);
  });

  it("CONFIDENTIAL_TRANSFER_VERIFIER is set", () => {
    expect(CONFIDENTIAL_TRANSFER_VERIFIER).toBe(
      "0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B"
    );
    expect(isHexAddress(CONFIDENTIAL_TRANSFER_VERIFIER)).toBe(true);
  });

  it("JANUS_TOKEN_OWNER_EVM is the admin COA", () => {
    expect(JANUS_TOKEN_OWNER_EVM).toBe("0x0000000000000000000000022f6b30af48a94787");
  });

  it("v0.3 addresses are all distinct", () => {
    const addrs = new Set([
      JANUS_FLOW_EVM_ADDRESS.toLowerCase(),
      JANUS_BABYJUB_ADDRESS.toLowerCase(),
      AMOUNT_DISCLOSE_VERIFIER.toLowerCase(),
      CONFIDENTIAL_TRANSFER_VERIFIER.toLowerCase(),
      JANUS_TOKEN_OWNER_EVM.toLowerCase(),
    ]);
    expect(addrs.size).toBe(5);
  });

  it("JANUS_FLOW_TESTNET wires the v0.3 verifier addresses", () => {
    expect(JANUS_FLOW_TESTNET.evmAddress).toBe(JANUS_FLOW_EVM_ADDRESS);
    expect(JANUS_FLOW_TESTNET.network).toBe("testnet");
    expect(JANUS_FLOW_TESTNET.babyJubAddress).toBe(JANUS_BABYJUB_ADDRESS);
    expect(JANUS_FLOW_TESTNET.amountDiscloseVerifierAddress).toBe(AMOUNT_DISCLOSE_VERIFIER);
    expect(JANUS_FLOW_TESTNET.confidentialTransferVerifierAddress).toBe(
      CONFIDENTIAL_TRANSFER_VERIFIER
    );
  });
});

describe("JANUS_TOKEN_DEPRECATED_ADDRESSES", () => {
  it("flags the v0.2 ElGamal proxy as deprecated (privacy leak)", () => {
    expect(JANUS_TOKEN_DEPRECATED_ADDRESSES.v02ElGamalProxy).toBe(
      "0x025efe7e89acdb8F315C804BE7245F348AA9c538"
    );
  });

  it("does NOT match any active v0.3 address", () => {
    const deprecated = Object.values(JANUS_TOKEN_DEPRECATED_ADDRESSES).map((a) =>
      a.toLowerCase()
    );
    expect(deprecated).not.toContain(JANUS_FLOW_EVM_ADDRESS.toLowerCase());
    expect(deprecated).not.toContain(AMOUNT_DISCLOSE_VERIFIER.toLowerCase());
    expect(deprecated).not.toContain(CONFIDENTIAL_TRANSFER_VERIFIER.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// ABI surface
// ---------------------------------------------------------------------------

describe("JANUS_TOKEN_BASE_ABI", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(JANUS_TOKEN_BASE_ABI)).toBe(true);
    expect(JANUS_TOKEN_BASE_ABI.length).toBeGreaterThan(0);
  });

  it("contains shieldedTransfer", () => {
    expect(JANUS_TOKEN_BASE_ABI.find((e) => e.includes("shieldedTransfer"))).toBeDefined();
  });

  it("contains balanceOfCommitment", () => {
    expect(JANUS_TOKEN_BASE_ABI.find((e) => e.includes("balanceOfCommitment"))).toBeDefined();
  });

  it("contains totalSupplyCommitment", () => {
    expect(JANUS_TOKEN_BASE_ABI.find((e) => e.includes("totalSupplyCommitment"))).toBeDefined();
  });

  it("contains totalLocked", () => {
    expect(JANUS_TOKEN_BASE_ABI.find((e) => e.includes("totalLocked"))).toBeDefined();
  });

  it("contains Wrapped event", () => {
    expect(JANUS_TOKEN_BASE_ABI.find((e) => e.includes("Wrapped"))).toBeDefined();
  });

  it("contains Unwrapped event", () => {
    expect(JANUS_TOKEN_BASE_ABI.find((e) => e.includes("Unwrapped"))).toBeDefined();
  });

  it("contains ConfidentialTransfer event", () => {
    expect(JANUS_TOKEN_BASE_ABI.find((e) => e.includes("ConfidentialTransfer"))).toBeDefined();
  });

  it("does NOT include v0.2 ElGamal entry points (registerPubkey, slotOf, encryptTo)", () => {
    expect(JANUS_TOKEN_BASE_ABI.find((e) => e.includes("registerPubkey"))).toBeUndefined();
    expect(JANUS_TOKEN_BASE_ABI.find((e) => e.includes("slotOf"))).toBeUndefined();
    expect(JANUS_TOKEN_BASE_ABI.find((e) => e.includes("encryptTo"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JanusToken class — API surface + guard checks
// ---------------------------------------------------------------------------

describe("JanusToken class", () => {
  it("constructs with TokenOptions", () => {
    const token = new JanusToken(JANUS_FLOW_TESTNET);
    expect(token).toBeDefined();
    expect(token.address).toBe(JANUS_FLOW_TESTNET.evmAddress);
  });

  it("balanceOfCommitment throws before connect", async () => {
    const token = new JanusToken(JANUS_FLOW_TESTNET);
    await expect(
      token.balanceOfCommitment("0x0000000000000000000000000000000000000001")
    ).rejects.toThrow(/not connected/);
  });

  it("totalSupplyCommitment throws before connect", async () => {
    const token = new JanusToken(JANUS_FLOW_TESTNET);
    await expect(token.totalSupplyCommitment()).rejects.toThrow(/not connected/);
  });

  it("totalLocked throws before connect", async () => {
    const token = new JanusToken(JANUS_FLOW_TESTNET);
    await expect(token.totalLocked()).rejects.toThrow(/not connected/);
  });

  it("shieldedTransfer rejects malformed publicInputs/proof length", async () => {
    const token = new JanusToken(JANUS_FLOW_TESTNET);
    await expect(
      token.shieldedTransfer({
        to: "0x000000000000000000000000000000000000dead",
        publicInputs: [1n, 2n, 3n] as readonly bigint[],
        proof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as readonly bigint[],
      })
    ).rejects.toThrow(/publicInputs must have 6/);

    await expect(
      token.shieldedTransfer({
        to: "0x000000000000000000000000000000000000dead",
        publicInputs: [1n, 2n, 3n, 4n, 5n, 6n] as readonly bigint[],
        proof: [1n, 2n, 3n] as readonly bigint[],
      })
    ).rejects.toThrow(/proof must have 8/);
  });
});
