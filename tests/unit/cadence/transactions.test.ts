/**
 * tests/unit/cadence/transactions.test.ts
 *
 * Verify Cadence transaction template generation.
 * Tests that templates include the right addresses, function signatures,
 * and structural elements. No Cadence runtime needed.
 */
import { describe, it, expect } from "vitest";
import {
  installInbox,
  installCheckpoint,
  installInboxAndCheckpoint,
  updateCheckpointViaCoa,
  combinedShieldedTransferWithCheckpoint,
  cadenceTx,
} from "../../../src/cadence/index";
import {
  CADENCE_DEPLOYER_ADDRESS,
  SHIELDED_CHECKPOINT_ADDRESS,
} from "../../../src/network/contracts";

const JANUS_FLOW_PROXY = "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3";

describe("cadence/transactions", () => {
  describe("installInbox", () => {
    it("imports ShieldedInbox from the default cadence deployer", () => {
      const tx = installInbox();
      expect(tx).toContain(`import ShieldedInbox from ${CADENCE_DEPLOYER_ADDRESS}`);
    });

    it("saves to /storage/shieldedInbox", () => {
      const tx = installInbox();
      expect(tx).toContain("/storage/shieldedInbox");
    });

    it("publishes Receiver capability at /public/shieldedInbox", () => {
      const tx = installInbox();
      expect(tx).toContain("/public/shieldedInbox");
      expect(tx).toContain("ShieldedInbox.Receiver");
    });

    it("accepts a custom deployer address", () => {
      const custom = "0xdeadbeefdeadbeef";
      const tx = installInbox(custom);
      expect(tx).toContain(`import ShieldedInbox from ${custom}`);
      expect(tx).not.toContain(CADENCE_DEPLOYER_ADDRESS);
    });
  });

  describe("installCheckpoint", () => {
    it("imports ShieldedCheckpoint from the default cadence deployer", () => {
      const tx = installCheckpoint();
      expect(tx).toContain(`import ShieldedCheckpoint from ${CADENCE_DEPLOYER_ADDRESS}`);
    });

    it("saves to /storage/shieldedCheckpoint", () => {
      const tx = installCheckpoint();
      expect(tx).toContain("/storage/shieldedCheckpoint");
    });

    it("publishes Metadata capability at /public/shieldedCheckpoint", () => {
      const tx = installCheckpoint();
      expect(tx).toContain("/public/shieldedCheckpoint");
      expect(tx).toContain("ShieldedCheckpoint.Metadata");
    });
  });

  describe("installInboxAndCheckpoint", () => {
    it("imports both contracts", () => {
      const tx = installInboxAndCheckpoint();
      expect(tx).toContain("import ShieldedInbox from");
      expect(tx).toContain("import ShieldedCheckpoint from");
    });

    it("installs both resources in one transaction", () => {
      const tx = installInboxAndCheckpoint();
      expect(tx).toContain("/storage/shieldedInbox");
      expect(tx).toContain("/storage/shieldedCheckpoint");
    });
  });

  describe("updateCheckpointViaCoa", () => {
    it("imports EVM from standard testnet address", () => {
      const tx = updateCheckpointViaCoa();
      expect(tx).toContain("import EVM from 0x8c5303eaa26202d6");
    });

    it("uses the default checkpoint EVM address", () => {
      const tx = updateCheckpointViaCoa();
      expect(tx).toContain(SHIELDED_CHECKPOINT_ADDRESS);
    });

    it("encodes update(address,bytes,uint256,uint256,uint64) function signature (v0.8.2 multi-token)", () => {
      const tx = updateCheckpointViaCoa();
      expect(tx).toContain("update(address,bytes,uint256,uint256,uint64)");
    });

    it("includes tokenAddrHex Cadence transaction arg", () => {
      const tx = updateCheckpointViaCoa();
      expect(tx).toContain("tokenAddrHex");
    });

    it("wraps snapshot bytes with EVM.EVMBytes(value:)", () => {
      const tx = updateCheckpointViaCoa();
      expect(tx).toContain("EVM.EVMBytes(value:");
    });

    it("uses /storage/evm for COA borrow path", () => {
      const tx = updateCheckpointViaCoa();
      expect(tx).toContain("/storage/evm");
    });

    it("asserts EVM.Status.successful", () => {
      const tx = updateCheckpointViaCoa();
      expect(tx).toContain("EVM.Status.successful");
    });

    it("accepts custom checkpoint address override", () => {
      const custom = "0x1234567890abcdef1234567890abcdef12345678";
      const tx = updateCheckpointViaCoa(custom);
      expect(tx).toContain(custom);
      expect(tx).not.toContain(SHIELDED_CHECKPOINT_ADDRESS);
    });
  });

  describe("combinedShieldedTransferWithCheckpoint", () => {
    it("embeds the JanusFlow proxy address", () => {
      const tx = combinedShieldedTransferWithCheckpoint(JANUS_FLOW_PROXY);
      expect(tx).toContain(JANUS_FLOW_PROXY);
    });

    it("uses the default checkpoint address", () => {
      const tx = combinedShieldedTransferWithCheckpoint(JANUS_FLOW_PROXY);
      expect(tx).toContain(SHIELDED_CHECKPOINT_ADDRESS);
    });

    it("encodes shieldedTransfer ABI signature (6-arg v0.8)", () => {
      const tx = combinedShieldedTransferWithCheckpoint(JANUS_FLOW_PROXY);
      expect(tx).toContain(
        "shieldedTransfer(address,uint256[6],uint256[8],bytes,uint256,uint256)",
      );
    });

    it("encodes checkpoint update ABI signature (v0.8.2 multi-token)", () => {
      const tx = combinedShieldedTransferWithCheckpoint(JANUS_FLOW_PROXY);
      expect(tx).toContain("update(address,bytes,uint256,uint256,uint64)");
    });

    it("wraps encryptedSnapshot and encryptedNoteTo with EVM.EVMBytes(value:)", () => {
      const tx = combinedShieldedTransferWithCheckpoint(JANUS_FLOW_PROXY);
      const evmBytesCount = (tx.match(/EVM\.EVMBytes\(value:/g) ?? []).length;
      expect(evmBytesCount).toBeGreaterThanOrEqual(1);
    });

    it("has two separate EVM COA calls (transfer + checkpoint)", () => {
      const tx = combinedShieldedTransferWithCheckpoint(JANUS_FLOW_PROXY);
      // Both EVM call results are asserted
      const successCount = (tx.match(/EVM\.Status\.successful/g) ?? []).length;
      expect(successCount).toBe(2);
    });

    it("accepts a custom checkpoint address", () => {
      const customCp = "0x9999999999999999999999999999999999999999";
      const tx = combinedShieldedTransferWithCheckpoint(JANUS_FLOW_PROXY, customCp);
      expect(tx).toContain(customCp);
      expect(tx).not.toContain(SHIELDED_CHECKPOINT_ADDRESS);
    });
  });

  describe("cadenceTx namespace bundle", () => {
    it("exposes all original template functions plus atomic templates", () => {
      expect(typeof cadenceTx.installInbox).toBe("function");
      expect(typeof cadenceTx.installCheckpoint).toBe("function");
      expect(typeof cadenceTx.installInboxAndCheckpoint).toBe("function");
      expect(typeof cadenceTx.updateCheckpointViaCoa).toBe("function");
      expect(typeof cadenceTx.combinedShieldedTransferWithCheckpoint).toBe("function");
      // Atomic templates (moved from PrivateTip frontend in v0.8.2)
      expect(typeof cadenceTx.wrapFlowAtomic).toBe("function");
      expect(typeof cadenceTx.sendTipAtomic).toBe("function");
      expect(typeof cadenceTx.unwrapFlowAtomic).toBe("function");
      expect(typeof cadenceTx.claimBatchAtomic).toBe("function");
    });

    it("namespace functions produce the same output as named exports", () => {
      expect(cadenceTx.installInbox()).toBe(installInbox());
      expect(cadenceTx.installCheckpoint()).toBe(installCheckpoint());
      expect(cadenceTx.updateCheckpointViaCoa()).toBe(updateCheckpointViaCoa());
    });
  });
});
