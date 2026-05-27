/**
 * Unit tests for JanusFlow v0.3 — no network required.
 *
 * Validates the concrete native-FLOW class, Cadence helper, and constants
 * for the v0.3 deployment (cross-VM EVM proxy at
 * 0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078, router at 0x5dcbeb41055ec57e).
 */

import { describe, it, expect } from "vitest";
import {
  JanusFlow,
  JanusFlowCadence,
  JANUS_FLOW_TESTNET,
  JANUS_FLOW_EVM_ADDRESS,
  JANUS_FLOW_EVM_IMPL_ADDRESS,
  JANUS_FLOW_CADENCE_ADDRESS,
  JANUS_FLOW_CONTRACT_NAME,
  JANUS_FLOW_VERSION,
  JANUS_FLOW_MAX_WRAP_ATTOFLOW,
  JANUS_FLOW_EXTRA_ABI,
  JANUS_FLOW_EVM_ADDRESS_DEPRECATED_V02,
  JANUS_FLOW_CADENCE_ADDRESS_LEGACY,
  TX_WRAP,
  TX_SHIELDED_TRANSFER,
  TX_UNWRAP,
  SCRIPT_IS_PAUSED,
  SCRIPT_GET_ACTIVE_IMPL_VERSION,
} from "../../src/tokens/janus-flow";

function isHexAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

describe("v0.3 JanusFlow constants", () => {
  it("EVM proxy address is the v0.3 deployment", () => {
    expect(JANUS_FLOW_EVM_ADDRESS).toBe("0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078");
    expect(isHexAddress(JANUS_FLOW_EVM_ADDRESS)).toBe(true);
  });

  it("EVM impl address is the v0.3 implementation", () => {
    expect(JANUS_FLOW_EVM_IMPL_ADDRESS).toBe("0x9321dF5884021D7E19Ad0EB5F582f8E2A70236eC");
    expect(isHexAddress(JANUS_FLOW_EVM_IMPL_ADDRESS)).toBe(true);
  });

  it("Cadence router address is the v0.3 deployment", () => {
    expect(JANUS_FLOW_CADENCE_ADDRESS).toBe("0x5dcbeb41055ec57e");
    expect(JANUS_FLOW_CONTRACT_NAME).toBe("JanusFlow");
  });

  it("version is 0.3.0", () => {
    expect(JANUS_FLOW_VERSION).toBe("0.3.0");
  });

  it("MAX_WRAP matches contract constant (18 FLOW in attoFLOW)", () => {
    expect(JANUS_FLOW_MAX_WRAP_ATTOFLOW).toBe(18_000_000_000_000_000_000n);
    // Less than 2^64 (the circuit range proof's upper bound)
    expect(JANUS_FLOW_MAX_WRAP_ATTOFLOW).toBeLessThan(1n << 64n);
  });

  it("deprecated v0.2 EVM address is flagged separately", () => {
    expect(JANUS_FLOW_EVM_ADDRESS_DEPRECATED_V02).toBe(
      "0x025efe7e89acdb8F315C804BE7245F348AA9c538"
    );
    expect(JANUS_FLOW_EVM_ADDRESS_DEPRECATED_V02).not.toBe(JANUS_FLOW_EVM_ADDRESS);
  });

  it("legacy v1 Cadence zombie is flagged separately", () => {
    expect(JANUS_FLOW_CADENCE_ADDRESS_LEGACY).toBe("0x28fef3d1d6a12800");
    expect(JANUS_FLOW_CADENCE_ADDRESS_LEGACY).not.toBe(JANUS_FLOW_CADENCE_ADDRESS);
  });
});

describe("JANUS_FLOW_EXTRA_ABI", () => {
  it("includes MAX_WRAP, wrap, and unwrap", () => {
    expect(JANUS_FLOW_EXTRA_ABI.find((e) => e.includes("MAX_WRAP"))).toBeDefined();
    expect(JANUS_FLOW_EXTRA_ABI.find((e) => /\bwrap\(/.test(e))).toBeDefined();
    expect(JANUS_FLOW_EXTRA_ABI.find((e) => /\bunwrap\(/.test(e))).toBeDefined();
  });

  it("wrap takes uint256[2] + uint256[8] and is payable", () => {
    const wrap = JANUS_FLOW_EXTRA_ABI.find((e) => /\bwrap\(/.test(e));
    expect(wrap).toMatch(/uint256\[2\]/);
    expect(wrap).toMatch(/uint256\[8\]/);
    expect(wrap).toMatch(/payable/);
  });

  it("unwrap takes claimedAmount + recipient + two proofs", () => {
    const unwrap = JANUS_FLOW_EXTRA_ABI.find((e) => /\bunwrap\(/.test(e));
    expect(unwrap).toMatch(/uint256\[2\]/);
    expect(unwrap).toMatch(/uint256\[6\]/);
    // Two distinct uint256[8] params
    expect((unwrap?.match(/uint256\[8\]/g) ?? []).length).toBe(2);
  });
});

describe("JanusFlow class", () => {
  it("constructs with no arguments (canonical testnet defaults)", () => {
    const flow = new JanusFlow();
    expect(flow.address).toBe(JANUS_FLOW_EVM_ADDRESS);
  });

  it("constructs with a partial override (e.g. mainnet)", () => {
    const flow = new JanusFlow({ network: "mainnet" });
    // Network is overridden, the EVM address default still points at testnet
    // (mainnet has no v0.3 deployment yet — caller must override evmAddress).
    expect(flow).toBeDefined();
  });

  it("wrap throws before connect", async () => {
    const flow = new JanusFlow();
    await expect(
      flow.wrap({
        amountWei: 1_000_000_000_000_000_000n,
        txCommit: [1n, 1n] as readonly bigint[],
        amountProof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as readonly bigint[],
      })
    ).rejects.toThrow(/not connected/);
  });

  it("wrap rejects amountWei == 0", async () => {
    const flow = new JanusFlow();
    await expect(
      flow.wrap({
        amountWei: 0n,
        txCommit: [1n, 1n] as readonly bigint[],
        amountProof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as readonly bigint[],
      })
    ).rejects.toThrow(/must be > 0/);
  });

  it("wrap rejects amountWei > MAX_WRAP", async () => {
    const flow = new JanusFlow();
    await expect(
      flow.wrap({
        amountWei: JANUS_FLOW_MAX_WRAP_ATTOFLOW + 1n,
        txCommit: [1n, 1n] as readonly bigint[],
        amountProof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as readonly bigint[],
      })
    ).rejects.toThrow(/exceeds MAX_WRAP/);
  });

  it("wrap rejects malformed txCommit", async () => {
    const flow = new JanusFlow();
    await expect(
      flow.wrap({
        amountWei: 1n,
        txCommit: [1n] as readonly bigint[],
        amountProof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as readonly bigint[],
      })
    ).rejects.toThrow(/txCommit must have 2/);
  });

  it("wrap rejects malformed amountProof", async () => {
    const flow = new JanusFlow();
    await expect(
      flow.wrap({
        amountWei: 1n,
        txCommit: [1n, 1n] as readonly bigint[],
        amountProof: [1n, 2n] as readonly bigint[],
      })
    ).rejects.toThrow(/amountProof must have 8/);
  });

  it("unwrap throws before connect", async () => {
    const flow = new JanusFlow();
    await expect(
      flow.unwrap({
        claimedAmountWei: 1_000_000_000_000_000_000n,
        recipient: "0x000000000000000000000000000000000000dead",
        txCommit: [1n, 1n] as readonly bigint[],
        amountProof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as readonly bigint[],
        transferPublicInputs: [1n, 2n, 3n, 4n, 5n, 6n] as readonly bigint[],
        transferProof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as readonly bigint[],
      })
    ).rejects.toThrow(/not connected/);
  });

  it("unwrap argument length validation runs before contract call", async () => {
    const flow = new JanusFlow();
    await expect(
      flow.unwrap({
        claimedAmountWei: 1n,
        recipient: "0x000000000000000000000000000000000000dead",
        txCommit: [1n] as readonly bigint[],
        amountProof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as readonly bigint[],
        transferPublicInputs: [1n, 2n, 3n, 4n, 5n, 6n] as readonly bigint[],
        transferProof: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as readonly bigint[],
      })
    ).rejects.toThrow(/txCommit/);
  });
});

describe("Cadence transaction templates", () => {
  it("TX_WRAP imports JanusFlow from the v0.3 router address", () => {
    expect(TX_WRAP).toContain("import JanusFlow from 0x5dcbeb41055ec57e");
  });

  it("TX_SHIELDED_TRANSFER imports the v0.3 router", () => {
    expect(TX_SHIELDED_TRANSFER).toContain("import JanusFlow from 0x5dcbeb41055ec57e");
    expect(TX_SHIELDED_TRANSFER).toContain("shieldedTransfer");
  });

  it("TX_UNWRAP imports the v0.3 router and references both proofs", () => {
    expect(TX_UNWRAP).toContain("import JanusFlow from 0x5dcbeb41055ec57e");
    expect(TX_UNWRAP).toContain("transferProof");
    expect(TX_UNWRAP).toContain("amountProof");
  });

  it("SCRIPT_IS_PAUSED imports the v0.3 router", () => {
    expect(SCRIPT_IS_PAUSED).toContain("import JanusFlow from 0x5dcbeb41055ec57e");
  });

  it("SCRIPT_GET_ACTIVE_IMPL_VERSION imports the v0.3 router", () => {
    expect(SCRIPT_GET_ACTIVE_IMPL_VERSION).toContain(
      "import JanusFlow from 0x5dcbeb41055ec57e"
    );
  });
});

describe("JanusFlowCadence helper", () => {
  it("constructs with default testnet", () => {
    const c = new JanusFlowCadence();
    expect(c).toBeDefined();
  });

  it("exposes view methods", () => {
    const c = new JanusFlowCadence({ network: "testnet" });
    expect(typeof c.isPaused).toBe("function");
    expect(typeof c.getActiveImplVersion).toBe("function");
    expect(typeof c.getTotalLocked).toBe("function");
    expect(typeof c.getEvmTarget).toBe("function");
    expect(typeof c.configure).toBe("function");
  });
});

describe("TokenOptions wiring", () => {
  it("JANUS_FLOW_TESTNET points at v0.3 addresses", () => {
    expect(JANUS_FLOW_TESTNET.evmAddress).toBe(JANUS_FLOW_EVM_ADDRESS);
    expect(JANUS_FLOW_TESTNET.network).toBe("testnet");
  });
});
