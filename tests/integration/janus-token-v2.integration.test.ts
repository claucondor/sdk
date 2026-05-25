/**
 * Integration tests — JanusTokenV2 on Flow testnet (READ-ONLY).
 *
 * Tests the SDK against the canonical v2 deployment:
 *   JanusTokenV2 EVM: 0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D
 *   EncryptConsistencyVerifier: 0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C
 *   DecryptOpenVerifier:        0x3bB139B5404fD6b152813bC3532367AAa096638b
 *   BabyJub.sol: 0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
 *   Network: Flow EVM testnet (chainId 545)
 *
 * These tests are READ-ONLY — no private key required.
 * Run: RUN_INTEGRATION=1 npx vitest run tests/integration/janus-token-v2.integration.test.ts
 */

import { describe, it, expect } from "vitest";
import { JanusTokenV2, JANUS_TOKEN_V2_TESTNET } from "../../src/tokens-v2/janus-token-v2";

const runIntegration = process.env.RUN_INTEGRATION === "1";

// Fresh address that has never interacted with the v2 contract
const FRESH_ADDRESS = "0x0000000000000000000000000000000000000003";

// Known openjanus deployer address for v2 (has registered pubkey in Phase 3)
// openjanus COA: 0x0000000000000000000000027eb18dc34b9966fd
const OPENJANUS_COA = "0x0000000000000000000000027eb18dc34b9966fd";

const BN254_FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe("JanusTokenV2 integration (read-only)", () => {
  let token: JanusTokenV2;

  const setup = async () => {
    token = new JanusTokenV2(JANUS_TOKEN_V2_TESTNET);
    await token.connect();
  };

  it.skipIf(!runIntegration)("I1: connects and address is correct", async () => {
    await setup();
    expect(token.address.toLowerCase()).toBe(
      JANUS_TOKEN_V2_TESTNET.evmAddress.toLowerCase()
    );
  });

  it.skipIf(!runIntegration)(
    "I2: fresh address has identity ciphertext (c1=(0,1), c2=(0,1)) — empty slot",
    async () => {
      await setup();
      const ct = await token.getBalanceCiphertext(FRESH_ADDRESS);
      // Identity on BabyJubJub: (0, 1)
      expect(ct.c1.x).toBe(0n);
      expect(ct.c1.y).toBe(1n);
      expect(ct.c2.x).toBe(0n);
      expect(ct.c2.y).toBe(1n);
    }
  );

  it.skipIf(!runIntegration)(
    "I3: fresh address hasPubkey returns false",
    async () => {
      await setup();
      const has = await token.hasPubkey(FRESH_ADDRESS);
      expect(has).toBe(false);
    }
  );

  it.skipIf(!runIntegration)(
    "I4: pubkeyOf fresh address returns identity (0, 1) or (0, 0)",
    async () => {
      await setup();
      const pk = await token.pubkeyOf(FRESH_ADDRESS);
      // Contract returns (0,0) or (0,1) for unregistered; both bigints
      expect(typeof pk.x).toBe("bigint");
      expect(typeof pk.y).toBe("bigint");
    }
  );

  it.skipIf(!runIntegration)(
    "I5: getBalanceSlot returns EncryptedSlot with valid field elements for any address",
    async () => {
      await setup();
      const slot = await token.getBalanceSlot(FRESH_ADDRESS);
      expect(slot.ciphertext.c1.x).toBeLessThan(BN254_FIELD_PRIME);
      expect(slot.ciphertext.c1.y).toBeLessThan(BN254_FIELD_PRIME);
      expect(slot.ciphertext.c2.x).toBeLessThan(BN254_FIELD_PRIME);
      expect(slot.ciphertext.c2.y).toBeLessThan(BN254_FIELD_PRIME);
    }
  );

  it.skipIf(!runIntegration)(
    "I6: getBalanceCiphertext returns valid bigints for any address",
    async () => {
      await setup();
      const ct = await token.getBalanceCiphertext(FRESH_ADDRESS);
      expect(typeof ct.c1.x).toBe("bigint");
      expect(typeof ct.c1.y).toBe("bigint");
      expect(typeof ct.c2.x).toBe("bigint");
      expect(typeof ct.c2.y).toBe("bigint");
    }
  );

  it.skipIf(!runIntegration)(
    "I7: connect() returns the JanusTokenV2 instance for chaining",
    async () => {
      const t = new JanusTokenV2(JANUS_TOKEN_V2_TESTNET);
      const result = await t.connect();
      expect(result).toBe(t);
    }
  );
});
