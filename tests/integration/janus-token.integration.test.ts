/**
 * Integration tests — JanusToken EVM contract on Flow testnet.
 *
 * Tests the SDK against the deployed JanusToken contract:
 *   EVM: 0x53F49881A1132FF4F674D2c015e35D5B07Fa1F4A (NATIVE mode)
 *   Network: Flow EVM testnet (chainId 545)
 *
 * These tests are READ-ONLY — no private key required.
 * Run: npx vitest run tests/integration/janus-token.integration.test.ts
 */

import { describe, it, expect } from "vitest";
import { JanusToken, JANUS_TOKEN_TESTNET } from "../../src/tokens/janus-token";

const CURVE_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// A low-numbered address (all zeros except last byte) that has never been minted to.
// Using address 0x2 (valid checksum, guaranteed fresh on this testnet demo contract).
const FRESH_ADDRESS = "0x0000000000000000000000000000000000000002";

describe("JanusToken integration (read-only)", () => {
  let token: JanusToken;

  const setup = async () => {
    token = new JanusToken(JANUS_TOKEN_TESTNET);
    await token.connect();
  };

  it("I1: connects and address is correct", async () => {
    await setup();
    expect(token.address.toLowerCase()).toBe(
      JANUS_TOKEN_TESTNET.evmAddress.toLowerCase()
    );
  });

  it("I2: fresh address has identity commitment (0, 1) — zero balance", async () => {
    await setup();
    const commit = await token.balanceOfCommitment(FRESH_ADDRESS);
    expect(commit.x).toBe(0n);
    expect(commit.y).toBe(1n);
  });

  it("I3: contract is in NATIVE mode (no underlying ERC-20)", async () => {
    await setup();
    const isWrapper = await token.isWrapperMode();
    expect(isWrapper).toBe(false);
  });

  it("I4: total supply commitment is accessible and valid", async () => {
    await setup();
    const supply = await token.totalSupplyCommitment();
    expect(typeof supply.x).toBe("bigint");
    expect(typeof supply.y).toBe("bigint");
    expect(supply.x).toBeLessThan(CURVE_P);
    expect(supply.y).toBeLessThan(CURVE_P);
    expect(supply.y).toBeGreaterThan(0n);
  });

  it("I5: balanceOfCommitment returns valid field elements for any address", async () => {
    await setup();
    const addr = "0x0000000000000000000000000000000000000001";
    const c = await token.balanceOfCommitment(addr);
    expect(c.x).toBeLessThan(CURVE_P);
    expect(c.y).toBeLessThan(CURVE_P);
  });
});
