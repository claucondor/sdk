/**
 * Integration tests — v0.3 JanusFlow on Flow EVM + Cadence testnet (READ-ONLY).
 *
 * Validates the SDK against the canonical v0.3 deployment:
 *   JanusFlow EVM proxy:           0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078
 *   AmountDiscloseVerifier:        0xD0ED3936530258C278f5357C1dB709ad34768352
 *   ConfidentialTransferVerifier:  0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B
 *   BabyJub (re-used):             0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
 *   Cadence router:                0x5dcbeb41055ec57e
 *   Network: Flow EVM testnet (chainId 545) + Cadence testnet
 *
 * These tests are READ-ONLY — no private key required.
 * Run: RUN_INTEGRATION=1 npx vitest run tests/integration/janus-flow.integration.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  JanusFlow,
  JanusFlowCadence,
  JANUS_FLOW_EVM_ADDRESS,
  JANUS_FLOW_CADENCE_ADDRESS,
  JANUS_FLOW_VERSION,
  JANUS_BABYJUB_ADDRESS,
  AMOUNT_DISCLOSE_VERIFIER,
  CONFIDENTIAL_TRANSFER_VERIFIER,
  JANUS_TOKEN_OWNER_EVM,
} from "../../src/tokens";

const runIntegration = process.env.RUN_INTEGRATION === "1";

const BN254_FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Fresh EVM address that has never interacted with the v0.3 contract
const FRESH_EVM = "0x0000000000000000000000000000000000000003";

describe("v0.3 JanusFlow EVM integration (read-only)", () => {
  it.skipIf(!runIntegration)(
    "EVM-I1: connects and address matches canonical",
    async () => {
      const flow = new JanusFlow();
      await flow.connect();
      expect(flow.address.toLowerCase()).toBe(JANUS_FLOW_EVM_ADDRESS.toLowerCase());
    }
  );

  it.skipIf(!runIntegration)(
    "EVM-I2: babyJub() returns canonical BabyJub address",
    async () => {
      const flow = new JanusFlow();
      await flow.connect();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const addr = await (flow as any)._contract().babyJub();
      expect(String(addr).toLowerCase()).toBe(JANUS_BABYJUB_ADDRESS.toLowerCase());
    }
  );

  it.skipIf(!runIntegration)(
    "EVM-I3: amountDiscloseVerifier() matches canonical address",
    async () => {
      const flow = new JanusFlow();
      await flow.connect();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const addr = await (flow as any)._contract().amountDiscloseVerifier();
      expect(String(addr).toLowerCase()).toBe(AMOUNT_DISCLOSE_VERIFIER.toLowerCase());
    }
  );

  it.skipIf(!runIntegration)(
    "EVM-I4: transferVerifier() matches canonical address",
    async () => {
      const flow = new JanusFlow();
      await flow.connect();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const addr = await (flow as any)._contract().transferVerifier();
      expect(String(addr).toLowerCase()).toBe(
        CONFIDENTIAL_TRANSFER_VERIFIER.toLowerCase()
      );
    }
  );

  it.skipIf(!runIntegration)(
    "EVM-I5: owner() matches the admin COA",
    async () => {
      const flow = new JanusFlow();
      await flow.connect();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const owner = await (flow as any)._contract().owner();
      expect(String(owner).toLowerCase()).toBe(JANUS_TOKEN_OWNER_EVM.toLowerCase());
    }
  );

  it.skipIf(!runIntegration)(
    "EVM-I6: totalLocked is a non-negative bigint",
    async () => {
      const flow = new JanusFlow();
      await flow.connect();
      const v = await flow.totalLocked();
      expect(typeof v).toBe("bigint");
      expect(v).toBeGreaterThanOrEqual(0n);
    }
  );

  it.skipIf(!runIntegration)(
    "EVM-I7: maxWrap returns the bundled constant (~18 FLOW)",
    async () => {
      const flow = new JanusFlow();
      await flow.connect();
      const max = await flow.maxWrap();
      expect(max).toBe(18_000_000_000_000_000_000n);
    }
  );

  it.skipIf(!runIntegration)(
    "EVM-I8: totalSupplyCommitment is a valid Point in field",
    async () => {
      const flow = new JanusFlow();
      await flow.connect();
      const p = await flow.totalSupplyCommitment();
      expect(typeof p.x).toBe("bigint");
      expect(typeof p.y).toBe("bigint");
      expect(p.x).toBeLessThan(BN254_FIELD_PRIME);
      expect(p.y).toBeLessThan(BN254_FIELD_PRIME);
    }
  );

  it.skipIf(!runIntegration)(
    "EVM-I9: balanceOfCommitment for a fresh address returns identity (0,1) or (0,0)",
    async () => {
      const flow = new JanusFlow();
      await flow.connect();
      const p = await flow.balanceOfCommitment(FRESH_EVM);
      // Either identity (0,1) or uninitialized (0,0) — both treated as zero on-chain.
      expect(p.x).toBe(0n);
      expect([0n, 1n]).toContain(p.y);
    }
  );
});

describe("v0.3 JanusFlow Cadence integration (read-only)", () => {
  it("Cadence-C0: SDK constants match the v0.3 router deployment", () => {
    expect(JANUS_FLOW_CADENCE_ADDRESS).toBe("0x5dcbeb41055ec57e");
    expect(JANUS_FLOW_VERSION).toBe("0.3.0");
  });

  it.skipIf(!runIntegration)(
    "Cadence-C1: router is not paused",
    async () => {
      const c = new JanusFlowCadence({ network: "testnet" });
      await c.configure();
      expect(await c.isPaused()).toBe(false);
    }
  );

  it.skipIf(!runIntegration)(
    "Cadence-C2: getActiveImplVersion returns a semver-shaped string",
    async () => {
      const c = new JanusFlowCadence({ network: "testnet" });
      await c.configure();
      const v = await c.getActiveImplVersion();
      expect(typeof v).toBe("string");
      // Router upgrades preserve the activeImpl field across deploys; production
      // value can lag behind the SDK constant. Match a semver shape, not exact.
      expect(v).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    }
  );

  it.skipIf(!runIntegration)(
    "Cadence-C3: getEvmTarget returns the v0.3 EVM proxy address",
    async () => {
      const c = new JanusFlowCadence({ network: "testnet" });
      await c.configure();
      const target = await c.getEvmTarget();
      // EVM.EVMAddress.toString() strips the 0x prefix — compare canonical hex.
      const normalize = (s: string) => s.toLowerCase().replace(/^0x/, "");
      expect(normalize(target)).toBe(normalize(JANUS_FLOW_EVM_ADDRESS));
    }
  );

  it.skipIf(!runIntegration)(
    "Cadence-C4: getTotalLocked returns a UFix64 string",
    async () => {
      const c = new JanusFlowCadence({ network: "testnet" });
      await c.configure();
      const total = await c.getTotalLocked();
      expect(typeof total).toBe("string");
      // UFix64 has up to 8 decimal places — parse as float and ensure non-negative
      expect(Number.parseFloat(total)).toBeGreaterThanOrEqual(0);
    }
  );
});
