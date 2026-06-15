/**
 * tests/unit/network/coa.test.ts
 *
 * Test the COA (Cadence-Owned Account) registry and EVM address lookup.
 */
import { describe, it, expect } from "vitest";
import { KNOWN_COAS, getKnownCOA } from "../../../src/network/coa";
import { CADENCE_DEPLOYER_ADDRESS, COA_DEPLOYER_EVM_ADDRESS } from "../../../src/network/contracts";

describe("network/coa", () => {
  it("KNOWN_COAS includes the v0.8 deployer entry", () => {
    expect(KNOWN_COAS).toHaveProperty(CADENCE_DEPLOYER_ADDRESS);
    expect(KNOWN_COAS[CADENCE_DEPLOYER_ADDRESS].toLowerCase()).toBe(
      COA_DEPLOYER_EVM_ADDRESS.toLowerCase(),
    );
  });

  it("getKnownCOA returns EVM address for known Cadence address", () => {
    const evmAddr = getKnownCOA(CADENCE_DEPLOYER_ADDRESS);
    expect(evmAddr).not.toBeNull();
    expect(evmAddr!.toLowerCase()).toBe(COA_DEPLOYER_EVM_ADDRESS.toLowerCase());
  });

  it("getKnownCOA returns null for unknown Cadence address", () => {
    const result = getKnownCOA("0xdeadbeefdeadbeef");
    expect(result).toBeNull();
  });

  it("KNOWN_COAS keys are lowercase hex Flow addresses (16 hex chars)", () => {
    for (const key of Object.keys(KNOWN_COAS)) {
      expect(key).toMatch(/^0x[0-9a-f]{16}$/);
    }
  });
});
