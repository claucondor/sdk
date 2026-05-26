/**
 * Integration tests — JanusFlow Cadence router on Flow testnet (READ-ONLY).
 *
 * Tests the SDK against the canonical v0.2.0-router deployment:
 *   JanusFlow Cadence (router): 0xbef3c77681c15397 (contract: JanusFlow)
 *   JanusFlowImpl:              0xbef3c77681c15397
 *   IJanusFlowImpl:             0xbef3c77681c15397
 *   Network: Flow Cadence testnet
 *
 * These tests are READ-ONLY — no admin keys required.
 * Run: RUN_INTEGRATION=1 npx vitest run tests/integration/janus-flow.integration.test.ts
 *
 * Deployment record: circuits/setup/deployments-router.json
 * Router e2e results: 25/25 PASS (2026-05-26)
 */

import { describe, it, expect } from "vitest";
import {
  JanusFlow,
  JANUS_FLOW_CADENCE_ADDRESS,
  JANUS_FLOW_VERSION,
  JANUS_FLOW_CADENCE_ADDRESS_LEGACY,
} from "../../src/tokens/janus-flow";

const runIntegration = process.env.RUN_INTEGRATION === "1";

// Known fresh address — no pubkey registered, empty slot
const FRESH_CADENCE_ADDR = "0x0000000000000000000000000000000000000003";

// openjanus router account (deployer of JanusFlow router)
const ROUTER_ACCOUNT = "0xbef3c77681c15397";

describe("JanusFlow integration (read-only, router pattern)", () => {
  it("R0: SDK constants are correct for router deployment", () => {
    expect(JANUS_FLOW_CADENCE_ADDRESS).toBe("0xbef3c77681c15397");
    expect(JANUS_FLOW_VERSION).toBe("0.2.0-router");
    // Legacy address must be the zombie, not the new canonical
    expect(JANUS_FLOW_CADENCE_ADDRESS_LEGACY).toBe("0x28fef3d1d6a12800");
    expect(JANUS_FLOW_CADENCE_ADDRESS).not.toBe(JANUS_FLOW_CADENCE_ADDRESS_LEGACY);
  });

  it.skipIf(!runIntegration)(
    "R1: JanusFlow router is not paused (active state after deployment)",
    async () => {
      const sdk = new JanusFlow({ network: "testnet" });
      await sdk.configure();
      const paused = await sdk.isPaused();
      expect(paused).toBe(false);
    }
  );

  it.skipIf(!runIntegration)(
    "R2: getActiveImplVersion returns a non-empty version string",
    async () => {
      const sdk = new JanusFlow({ network: "testnet" });
      await sdk.configure();
      const version = await sdk.getActiveImplVersion();
      expect(typeof version).toBe("string");
      expect(version.length).toBeGreaterThan(0);
      // Current impl is 0.1.0 per deployments-router.json
      expect(version).toBe("0.1.0");
    }
  );

  it.skipIf(!runIntegration)(
    "R3: fresh address has identity ciphertext (c1=(0,1), c2=(0,1)) — empty slot",
    async () => {
      const sdk = new JanusFlow({ network: "testnet" });
      await sdk.configure();
      const slot = await sdk.getSlot(FRESH_CADENCE_ADDR);
      expect(slot.c1.x).toBe(0n);
      expect(slot.c1.y).toBe(1n);
      expect(slot.c2.x).toBe(0n);
      expect(slot.c2.y).toBe(1n);
    }
  );

  it.skipIf(!runIntegration)(
    "R4: fresh address has identity pubkey (0, 1) — not registered",
    async () => {
      const sdk = new JanusFlow({ network: "testnet" });
      await sdk.configure();
      const pk = await sdk.getPubkey(FRESH_CADENCE_ADDR);
      expect(pk.x).toBe(0n);
      expect(pk.y).toBe(1n);
    }
  );
});

describe("JanusFlow admin API — type and constant checks (no network)", () => {
  it("A1: JanusFlow class exposes pause/unpause methods", () => {
    const sdk = new JanusFlow({ network: "testnet" });
    expect(typeof sdk.pause).toBe("function");
    expect(typeof sdk.unpause).toBe("function");
    expect(typeof sdk.isPaused).toBe("function");
  });

  it("A2: JanusFlow class exposes impl-swap methods", () => {
    const sdk = new JanusFlow({ network: "testnet" });
    expect(typeof sdk.finalizeImplSwap).toBe("function");
    expect(typeof sdk.cancelImplSwap).toBe("function");
    expect(typeof sdk.getActiveImplVersion).toBe("function");
  });

  it("A3: JanusFlow class exposes user-facing methods", () => {
    const sdk = new JanusFlow({ network: "testnet" });
    expect(typeof sdk.registerPubkey).toBe("function");
    expect(typeof sdk.wrapAndEncrypt).toBe("function");
    expect(typeof sdk.confidentialTransfer).toBe("function");
    expect(typeof sdk.decryptAndUnwrap).toBe("function");
    expect(typeof sdk.getSlot).toBe("function");
    expect(typeof sdk.getPubkey).toBe("function");
  });
});
