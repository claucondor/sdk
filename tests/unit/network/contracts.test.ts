/**
 * tests/unit/network/contracts.test.ts
 *
 * Verify v0.8 contract addresses, registry entries, and constants.
 * These tests guard against accidental address regressions.
 */
import { describe, it, expect } from "vitest";
import {
  TOKEN_REGISTRY,
  VERIFIERS,
  SHIELDED_INBOX_ADDRESS,
  SHIELDED_CHECKPOINT_ADDRESS,
  MEMO_REGISTRY_ADDRESS,
  CADENCE_DEPLOYER_ADDRESS,
  COA_DEPLOYER_EVM_ADDRESS,
  LEGACY_V071_JANUSFLOW_PROXY,
  UFIX64_SCALE,
  FLOW_EVM_RPC,
  FLOW_CADENCE_ACCESS,
} from "../../../src/network/contracts";

describe("network/contracts — v0.8 address constants", () => {
  it("TOKEN_REGISTRY has expected token ids", () => {
    const ids = Object.keys(TOKEN_REGISTRY);
    expect(ids).toContain("flow");
    expect(ids).toContain("mockusdc");
    expect(ids).toContain("mockft");
  });

  it("flow token is native variant with correct proxy", () => {
    const flow = TOKEN_REGISTRY.flow;
    expect(flow.variant).toBe("native");
    if (flow.variant === "native") {
      expect(flow.proxy.toLowerCase()).toBe("0xa64340c1d356835a2450306ffd290ed52c001ad3");
    }
  });

  it("mockusdc token is erc20 variant", () => {
    const mockusdc = TOKEN_REGISTRY.mockusdc;
    expect(mockusdc.variant).toBe("erc20");
    if (mockusdc.variant === "erc20") {
      expect(mockusdc.proxy.toLowerCase()).toBe("0xfd8f82be1782af1f85f4673065e94fb3f8d5387d");
    }
  });

  it("mockft token is cadence-ft variant with v0.8 deployer address", () => {
    const mockft = TOKEN_REGISTRY.mockft;
    expect(mockft.variant).toBe("cadence-ft");
    if (mockft.variant === "cadence-ft") {
      expect(mockft.cadenceAddress).toBe("0x4b6bc58bc8bf5dcc");
    }
  });

  it("VERIFIERS has transferVerifier and amountDiscloseVerifier", () => {
    expect(VERIFIERS).toHaveProperty("transferVerifier");
    expect(VERIFIERS).toHaveProperty("amountDiscloseVerifier");
    expect(VERIFIERS.transferVerifier.toLowerCase()).toBe(
      "0x38e69fe7ba7c2c586d64dffc14742641a675666c",
    );
    expect(VERIFIERS.amountDiscloseVerifier.toLowerCase()).toBe(
      "0xf7b634d41259d0613345633ee1cd193a030a6329",
    );
  });

  it("SHIELDED_INBOX_ADDRESS is correct", () => {
    expect(SHIELDED_INBOX_ADDRESS.toLowerCase()).toBe(
      "0x0c787aacba9a116eda4ec05be41d8474d470bfc6",
    );
  });

  it("SHIELDED_CHECKPOINT_ADDRESS is correct (v0.8.2 multi-token re-deploy)", () => {
    // Updated in v0.8.2 sprint A.4 — new multi-token contract
    // (old singleton 0xbF8dbE133FC1319570dBe43E32BFD9a6D64E1E76 is archived)
    expect(SHIELDED_CHECKPOINT_ADDRESS.toLowerCase()).toBe(
      "0x88c9fd443bc15d1cd24bc724db6928d3246b2e26",
    );
  });

  it("MEMO_REGISTRY_ADDRESS is v0.8 value", () => {
    expect(MEMO_REGISTRY_ADDRESS.toLowerCase()).toBe(
      "0x361bd4d037838a3a9c5408ae465d36077800ee6c",
    );
  });

  it("CADENCE_DEPLOYER_ADDRESS is v0.8 deployer", () => {
    expect(CADENCE_DEPLOYER_ADDRESS).toBe("0x4b6bc58bc8bf5dcc");
  });

  it("COA_DEPLOYER_EVM_ADDRESS is deterministic COA for deployer", () => {
    expect(COA_DEPLOYER_EVM_ADDRESS.toLowerCase()).toBe(
      "0x0000000000000000000000020885d7ad3582356a",
    );
  });

  it("LEGACY_V071_JANUSFLOW_PROXY is preserved for PrivateTip demo", () => {
    expect(LEGACY_V071_JANUSFLOW_PROXY.toLowerCase()).toBe(
      "0x9a83732417947ef9b7aea64bf807a345267c2fda",
    );
  });

  it("UFIX64_SCALE is 1e8 (10^8)", () => {
    expect(UFIX64_SCALE).toBe(100_000_000n);
  });

  it("RPC and access node URLs point to testnet", () => {
    expect(FLOW_EVM_RPC).toContain("testnet");
    expect(FLOW_CADENCE_ACCESS).toContain("testnet");
  });
});
