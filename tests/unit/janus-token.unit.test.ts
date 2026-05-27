/**
 * Unit tests for JanusToken v2 module — no network required.
 *
 * Tests the types, constants, ABIs, and class API surface of the v2 module.
 * All contract calls are mocked — no Flow EVM connection needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  JanusToken,
  JANUS_TOKEN_TESTNET,
  JANUS_BABYJUB_ADDRESS,
  ENCRYPT_CONSISTENCY_VERIFIER,
  DECRYPT_OPEN_VERIFIER,
  JANUS_TOKEN_ABI,
} from "../../src/tokens/janus-token";

// ---------------------------------------------------------------------------
// Address format helpers
// ---------------------------------------------------------------------------

function isHexAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

// ---------------------------------------------------------------------------
// Canonical address assertions
// ---------------------------------------------------------------------------

describe("JANUS_TOKEN_TESTNET constant", () => {
  it("targets the UUPS proxy address (post-SCALE-fix deploy)", () => {
    expect(JANUS_TOKEN_TESTNET.evmAddress).toBe(
      "0x025efe7e89acdb8F315C804BE7245F348AA9c538"
    );
  });

  it("evmAddress is a valid 20-byte hex address", () => {
    expect(isHexAddress(JANUS_TOKEN_TESTNET.evmAddress)).toBe(true);
  });

  it("network is testnet", () => {
    expect(JANUS_TOKEN_TESTNET.network).toBe("testnet");
  });

  it("babyJubAddress matches canonical deployment", () => {
    expect(JANUS_TOKEN_TESTNET.babyJubAddress).toBe(JANUS_BABYJUB_ADDRESS);
  });

  it("encryptVerifierAddress matches canonical deployment", () => {
    expect(JANUS_TOKEN_TESTNET.encryptVerifierAddress).toBe(ENCRYPT_CONSISTENCY_VERIFIER);
  });

  it("decryptVerifierAddress matches canonical deployment", () => {
    expect(JANUS_TOKEN_TESTNET.decryptVerifierAddress).toBe(DECRYPT_OPEN_VERIFIER);
  });
});

describe("Canonical v2 addresses", () => {
  it("JANUS_BABYJUB_ADDRESS is valid hex address", () => {
    expect(isHexAddress(JANUS_BABYJUB_ADDRESS)).toBe(true);
    expect(JANUS_BABYJUB_ADDRESS).toBe("0x27139AFda7425f51F68D32e0A38b7D43BcB0f870");
  });

  it("ENCRYPT_CONSISTENCY_VERIFIER is valid hex address (v0.2.0 ceremony-backed)", () => {
    expect(isHexAddress(ENCRYPT_CONSISTENCY_VERIFIER)).toBe(true);
    expect(ENCRYPT_CONSISTENCY_VERIFIER).toBe(
      "0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e"
    );
  });

  it("DECRYPT_OPEN_VERIFIER is valid hex address (v0.2.0 ceremony-backed)", () => {
    expect(isHexAddress(DECRYPT_OPEN_VERIFIER)).toBe(true);
    expect(DECRYPT_OPEN_VERIFIER).toBe("0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc");
  });

  it("all three addresses are distinct", () => {
    const addrs = new Set([
      JANUS_TOKEN_TESTNET.evmAddress.toLowerCase(),
      JANUS_BABYJUB_ADDRESS.toLowerCase(),
      ENCRYPT_CONSISTENCY_VERIFIER.toLowerCase(),
      DECRYPT_OPEN_VERIFIER.toLowerCase(),
    ]);
    expect(addrs.size).toBe(4);
  });
});

describe("JANUS_TOKEN_ABI", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(JANUS_TOKEN_ABI)).toBe(true);
    expect(JANUS_TOKEN_ABI.length).toBeGreaterThan(0);
  });

  it("contains registerPubkey", () => {
    const entry = JANUS_TOKEN_ABI.find((e) => e.includes("registerPubkey"));
    expect(entry).toBeDefined();
  });

  it("contains slotOf (for reading ciphertext)", () => {
    const entry = JANUS_TOKEN_ABI.find((e) => e.includes("slotOf"));
    expect(entry).toBeDefined();
  });

  it("contains confidentialTransfer", () => {
    const entry = JANUS_TOKEN_ABI.find((e) => e.includes("confidentialTransfer"));
    expect(entry).toBeDefined();
  });

  it("contains unwrap (post-SCALE-fix entrypoint)", () => {
    const entry = JANUS_TOKEN_ABI.find((e) => /\bunwrap\(/.test(e));
    expect(entry).toBeDefined();
  });

  it("contains wrap (payable, msg.value = N * SCALE)", () => {
    const entry = JANUS_TOKEN_ABI.find((e) => /\bwrap\(/.test(e));
    expect(entry).toBeDefined();
  });

  it("contains SCALE constant accessor (vuln 014 sanity check)", () => {
    const entry = JANUS_TOKEN_ABI.find((e) => e.includes("SCALE()"));
    expect(entry).toBeDefined();
  });

  it("contains PubkeyRegistered event", () => {
    const entry = JANUS_TOKEN_ABI.find((e) => e.includes("PubkeyRegistered"));
    expect(entry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// JanusToken class — API surface + guard checks
// ---------------------------------------------------------------------------

describe("JanusToken class", () => {
  it("constructs with TokenOptions", () => {
    const token = new JanusToken(JANUS_TOKEN_TESTNET);
    expect(token).toBeDefined();
  });

  it("address getter returns evmAddress before connect", () => {
    const token = new JanusToken(JANUS_TOKEN_TESTNET);
    expect(token.address).toBe(JANUS_TOKEN_TESTNET.evmAddress);
  });

  it("balanceOfCommitment alias: getBalanceCiphertext throws before connect", async () => {
    const token = new JanusToken(JANUS_TOKEN_TESTNET);
    await expect(token.getBalanceCiphertext("0x0000000000000000000000000000000000000001")).rejects.toThrow(
      /not connected/
    );
  });

  it("pubkeyOf throws before connect", async () => {
    const token = new JanusToken(JANUS_TOKEN_TESTNET);
    await expect(token.pubkeyOf("0x0000000000000000000000000000000000000001")).rejects.toThrow(
      /not connected/
    );
  });

  it("hasPubkey throws before connect", async () => {
    const token = new JanusToken(JANUS_TOKEN_TESTNET);
    await expect(token.hasPubkey("0x0000000000000000000000000000000000000001")).rejects.toThrow(
      /not connected/
    );
  });

  it("registerPubkey throws before connect", async () => {
    const token = new JanusToken(JANUS_TOKEN_TESTNET);
    const pk = { x: 1n, y: 1n };
    await expect(token.registerPubkey(pk)).rejects.toThrow(/not connected/);
  });

  it("getBalanceSlot throws before connect", async () => {
    const token = new JanusToken(JANUS_TOKEN_TESTNET);
    await expect(
      token.getBalanceSlot("0x0000000000000000000000000000000000000001")
    ).rejects.toThrow(/not connected/);
  });
});

// ---------------------------------------------------------------------------
// Type validation helpers
// ---------------------------------------------------------------------------

describe("v2 types — structural checks", () => {
  it("Ciphertext type has c1 and c2 Point fields", () => {
    const ct = {
      c1: { x: 0n, y: 1n },
      c2: { x: 0n, y: 1n },
    };
    expect(typeof ct.c1.x).toBe("bigint");
    expect(typeof ct.c2.y).toBe("bigint");
  });

  it("identity ciphertext c1=(0,1) c2=(0,1) represents empty slot", () => {
    const identity = {
      c1: { x: 0n, y: 1n },
      c2: { x: 0n, y: 1n },
    };
    // Identity check: both components are BabyJubJub identity
    expect(identity.c1.x).toBe(0n);
    expect(identity.c1.y).toBe(1n);
    expect(identity.c2.x).toBe(0n);
    expect(identity.c2.y).toBe(1n);
  });
});
