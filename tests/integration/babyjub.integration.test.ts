/**
 * Integration tests — BabyJub.sol on Flow EVM testnet.
 *
 * Tests on-chain point operations against the deployed contract:
 *   BabyJub.sol: 0x2c40513b343B70f2A0B7e6Ad6F997DDa819D6f07
 *   Network: Flow EVM testnet (chainId 545)
 *
 * Run: RUN_INTEGRATION=1 npx vitest run tests/integration/babyjub.integration.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  GENERATOR_G,
  IDENTITY_POINT,
  isOnCurveLocal,
  negatePoint,
  babyAddOnChain,
  isOnCurveOnChain,
  negateOnChain,
  identityOnChain,
  BABYJUB_CONTRACT_ADDRESS,
} from "../../src/primitives/babyjub";

const SKIP = !process.env["RUN_INTEGRATION"];

// Known reference values (2G = G + G)
const G2_X = 1676417244152142056454616115823988517566305896059373631785843290555309632953n;
const G2_Y = 11563908930482997415800970727888501192209530935490958274440594569809848042842n;

describe.skipIf(SKIP)("BabyJub.sol integration", () => {
  it("I1: identity() returns (0, 1)", async () => {
    const id = await identityOnChain();
    expect(id.x).toBe(0n);
    expect(id.y).toBe(1n);
  }, 30000);

  it("I2: babyAdd(G, G) returns 2G (known reference vector)", async () => {
    const G = GENERATOR_G;
    const result = await babyAddOnChain(G, G);
    expect(result.x).toBe(G2_X);
    expect(result.y).toBe(G2_Y);
  }, 30000);

  it("I3: babyAdd(G, identity) returns G", async () => {
    const G = GENERATOR_G;
    const id = IDENTITY_POINT;
    const result = await babyAddOnChain(G, id);
    expect(result.x).toBe(G.x);
    expect(result.y).toBe(G.y);
  }, 30000);

  it("I4: isOnCurve(G) returns true", async () => {
    const G = GENERATOR_G;
    const onCurve = await isOnCurveOnChain(G.x, G.y);
    expect(onCurve).toBe(true);
  }, 30000);

  it("I5: isOnCurve(1, 1) returns false", async () => {
    const onCurve = await isOnCurveOnChain(1n, 1n);
    expect(onCurve).toBe(false);
  }, 30000);

  it("I6: negate(G) on-chain matches local negatePoint(G)", async () => {
    const G = GENERATOR_G;
    const onChainNeg = await negateOnChain(G.x, G.y);
    const localNeg = negatePoint(G.x, G.y);
    expect(onChainNeg.x).toBe(localNeg.x);
    expect(onChainNeg.y).toBe(localNeg.y);
  }, 30000);

  it("I7: on-chain 2G is on curve locally", async () => {
    const G = GENERATOR_G;
    const g2 = await babyAddOnChain(G, G);
    expect(isOnCurveLocal(g2.x, g2.y)).toBe(true);
  }, 30000);
});

describe("BabyJub.sol integration (skipped without RUN_INTEGRATION=1)", () => {
  it("contract address is correctly configured", () => {
    expect(BABYJUB_CONTRACT_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
