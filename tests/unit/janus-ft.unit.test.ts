/**
 * Unit tests for JanusFT v0.4 — no network required.
 *
 * Validates the Cadence wrapper helper class, transaction templates, and
 * constants for the v0.4 deployment (canonical at 0xbef3c77681c15397).
 */

import { describe, it, expect } from "vitest";
import {
  JanusFTCadence,
  JANUS_FT_CADENCE_ADDRESS,
  JANUS_FT_CONTRACT_NAME,
  JANUS_FT_VERSION,
  JANUS_FT_DEFAULT_UNDERLYING_TYPE,
  JANUS_FT_SMOKE_MIRROR_ADDRESS,
  TX_FT_SETUP_REGISTRY,
  TX_FT_WRAP,
  TX_FT_SHIELDED_TRANSFER,
  TX_FT_UNWRAP,
  SCRIPT_FT_GET_TOTAL_LOCKED,
  SCRIPT_FT_GET_COMMITMENT,
  SCRIPT_FT_GET_UNDERLYING_TYPE,
  buildJanusFTTx,
} from "../../src/tokens/janus-ft";

function isFlowAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{16}$/.test(s);
}

describe("JanusFT v0.4 constants", () => {
  it("JANUS_FT_CADENCE_ADDRESS is a 16-char hex Flow address", () => {
    expect(isFlowAddress(JANUS_FT_CADENCE_ADDRESS)).toBe(true);
  });

  it("JANUS_FT_SMOKE_MIRROR_ADDRESS is a 16-char hex Flow address", () => {
    expect(isFlowAddress(JANUS_FT_SMOKE_MIRROR_ADDRESS)).toBe(true);
  });

  it("canonical and smoke-mirror addresses are distinct", () => {
    expect(JANUS_FT_CADENCE_ADDRESS.toLowerCase())
      .not.toBe(JANUS_FT_SMOKE_MIRROR_ADDRESS.toLowerCase());
  });

  it("JANUS_FT_CONTRACT_NAME is 'JanusFT'", () => {
    expect(JANUS_FT_CONTRACT_NAME).toBe("JanusFT");
  });

  it("JANUS_FT_VERSION is '0.4.0'", () => {
    expect(JANUS_FT_VERSION).toBe("0.4.0");
  });

  it("default underlying is testnet FlowToken.Vault", () => {
    expect(JANUS_FT_DEFAULT_UNDERLYING_TYPE).toBe("A.7e60df042a9c0868.FlowToken.Vault");
  });
});

describe("JanusFT Cadence transaction templates", () => {
  it("all TX templates import JanusFT from canonical address", () => {
    for (const tx of [TX_FT_SETUP_REGISTRY, TX_FT_WRAP, TX_FT_SHIELDED_TRANSFER, TX_FT_UNWRAP]) {
      expect(tx).toMatch(/import JanusFT from 0xbef3c77681c15397/);
    }
  });

  it("TX_FT_SHIELDED_TRANSFER takes NO cleartext amount parameter", () => {
    // Must take Address + [UInt256;6] + [UInt8] — no UFix64 amount.
    expect(TX_FT_SHIELDED_TRANSFER).toMatch(/transaction\(toAccount: Address, publicInputs: \[UInt256; 6\], proofBytes: \[UInt8\]\)/);
    expect(TX_FT_SHIELDED_TRANSFER).not.toMatch(/UFix64/);
  });

  it("TX_FT_WRAP takes cleartext amount (boundary leak — UFix64)", () => {
    expect(TX_FT_WRAP).toMatch(/amount: UFix64/);
  });

  it("TX_FT_UNWRAP takes cleartext claimedAmount (boundary leak)", () => {
    expect(TX_FT_UNWRAP).toMatch(/claimedAmount: UFix64/);
  });

  it("all SCRIPT templates import from canonical address", () => {
    for (const s of [SCRIPT_FT_GET_TOTAL_LOCKED, SCRIPT_FT_GET_COMMITMENT, SCRIPT_FT_GET_UNDERLYING_TYPE]) {
      expect(s).toMatch(/import JanusFT from 0xbef3c77681c15397/);
    }
  });
});

describe("buildJanusFTTx helper", () => {
  it("retargets a tx template to a different address", () => {
    const retargeted = buildJanusFTTx(TX_FT_SETUP_REGISTRY, "0x3c601a443c81e6cd");
    expect(retargeted).toMatch(/import JanusFT from 0x3c601a443c81e6cd/);
    expect(retargeted).not.toMatch(/0xbef3c77681c15397/);
  });

  it("accepts addr with or without 0x prefix", () => {
    const a = buildJanusFTTx(TX_FT_SETUP_REGISTRY, "3c601a443c81e6cd");
    const b = buildJanusFTTx(TX_FT_SETUP_REGISTRY, "0x3c601a443c81e6cd");
    expect(a).toBe(b);
  });

  it("does not mutate FlowToken / FungibleToken imports", () => {
    const retargeted = buildJanusFTTx(TX_FT_WRAP, "0x3c601a443c81e6cd");
    expect(retargeted).toMatch(/import FungibleToken from 0x9a0766d93b6608b7/);
    expect(retargeted).toMatch(/import FlowToken from 0x7e60df042a9c0868/);
  });
});

describe("JanusFTCadence class", () => {
  it("constructs with canonical defaults", () => {
    // We construct without configuring FCL (no network calls in constructor).
    const ft = new JanusFTCadence({ network: "testnet" });
    expect(ft).toBeInstanceOf(JanusFTCadence);
  });

  it("accepts a smoke-mirror contractAddress override", () => {
    const ft = new JanusFTCadence({
      network: "testnet",
      contractAddress: JANUS_FT_SMOKE_MIRROR_ADDRESS,
    });
    expect(ft).toBeInstanceOf(JanusFTCadence);
  });
});
