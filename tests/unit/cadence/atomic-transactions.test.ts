/**
 * tests/unit/cadence/atomic-transactions.spec.ts
 *
 * Verify atomic Cadence transaction templates (moved from PrivateTip frontend in v0.8.2).
 *
 * Tests verify:
 *   1. Each template contains EVM.EVMBytes(value:) for all [UInt8] → bytes calldata
 *   2. Each template references the SDK SHIELDED_CHECKPOINT_ADDRESS constant
 *   3. Each template encodes the new update(address,bytes,uint256,uint256,uint64) ABI
 *   4. `tokenAddrHex` is baked into the checkpoint call for each template
 *   5. The cadenceTx namespace exposes all atomic template functions
 *   6. Custom checkpoint address override works
 */

import { describe, it, expect } from "vitest";
import {
  updateCheckpointViaCoa,
  wrapFlowAtomic,
  sendTipAtomic,
  unwrapFlowAtomic,
  claimBatchAtomic,
  cadenceTx,
} from "../../../src/cadence/index";
import { SHIELDED_CHECKPOINT_ADDRESS, SHIELDED_INBOX_ADDRESS } from "../../../src/network/contracts";

const FLOW_PROXY  = "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3";
const MUSDC_PROXY = "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d";
const CUSTOM_CP   = "0x9999999999999999999999999999999999999999";

// ---------------------------------------------------------------------------
// EVM.EVMBytes guard — all templates MUST wrap [UInt8] → bytes calldata
// ---------------------------------------------------------------------------

describe("atomic-transactions — EVM.EVMBytes fix applied", () => {
  it("updateCheckpointViaCoa has EVM.EVMBytes(value:", () => {
    const tx = updateCheckpointViaCoa();
    expect(tx).toContain("EVM.EVMBytes(value:");
  });

  it("wrapFlowAtomic has EVM.EVMBytes(value:", () => {
    const tx = wrapFlowAtomic(FLOW_PROXY);
    expect(tx).toContain("EVM.EVMBytes(value:");
  });

  it("sendTipAtomic has EVM.EVMBytes(value:", () => {
    const tx = sendTipAtomic(FLOW_PROXY);
    expect(tx).toContain("EVM.EVMBytes(value:");
  });

  it("unwrapFlowAtomic has EVM.EVMBytes(value:", () => {
    const tx = unwrapFlowAtomic(FLOW_PROXY);
    expect(tx).toContain("EVM.EVMBytes(value:");
  });

  it("claimBatchAtomic has EVM.EVMBytes(value:", () => {
    const tx = claimBatchAtomic(FLOW_PROXY);
    expect(tx).toContain("EVM.EVMBytes(value:");
  });
});

// ---------------------------------------------------------------------------
// Checkpoint contract address
// ---------------------------------------------------------------------------

describe("atomic-transactions — checkpoint contract address", () => {
  it("updateCheckpointViaCoa uses SDK SHIELDED_CHECKPOINT_ADDRESS by default", () => {
    const tx = updateCheckpointViaCoa();
    expect(tx).toContain(SHIELDED_CHECKPOINT_ADDRESS);
  });

  it("wrapFlowAtomic uses SDK SHIELDED_CHECKPOINT_ADDRESS by default", () => {
    const tx = wrapFlowAtomic(FLOW_PROXY);
    expect(tx).toContain(SHIELDED_CHECKPOINT_ADDRESS);
  });

  it("sendTipAtomic uses SDK SHIELDED_CHECKPOINT_ADDRESS by default", () => {
    const tx = sendTipAtomic(FLOW_PROXY);
    expect(tx).toContain(SHIELDED_CHECKPOINT_ADDRESS);
  });

  it("unwrapFlowAtomic uses SDK SHIELDED_CHECKPOINT_ADDRESS by default", () => {
    const tx = unwrapFlowAtomic(FLOW_PROXY);
    expect(tx).toContain(SHIELDED_CHECKPOINT_ADDRESS);
  });

  it("claimBatchAtomic uses SDK SHIELDED_CHECKPOINT_ADDRESS by default", () => {
    const tx = claimBatchAtomic(FLOW_PROXY);
    expect(tx).toContain(SHIELDED_CHECKPOINT_ADDRESS);
  });

  it("all templates accept custom checkpoint address override", () => {
    expect(updateCheckpointViaCoa(CUSTOM_CP)).toContain(CUSTOM_CP);
    expect(wrapFlowAtomic(FLOW_PROXY, CUSTOM_CP)).toContain(CUSTOM_CP);
    expect(sendTipAtomic(FLOW_PROXY, CUSTOM_CP)).toContain(CUSTOM_CP);
    expect(unwrapFlowAtomic(FLOW_PROXY, CUSTOM_CP)).toContain(CUSTOM_CP);
    expect(claimBatchAtomic(FLOW_PROXY, CUSTOM_CP)).toContain(CUSTOM_CP);
  });
});

// ---------------------------------------------------------------------------
// Multi-token ABI encoding — update(address,bytes,...) signature
// ---------------------------------------------------------------------------

describe("atomic-transactions — multi-token update ABI", () => {
  it("updateCheckpointViaCoa encodes update(address,bytes,uint256,uint256,uint64)", () => {
    const tx = updateCheckpointViaCoa();
    expect(tx).toContain("update(address,bytes,uint256,uint256,uint64)");
  });

  it("wrapFlowAtomic encodes update(address,bytes,uint256,uint256,uint64)", () => {
    const tx = wrapFlowAtomic(FLOW_PROXY);
    expect(tx).toContain("update(address,bytes,uint256,uint256,uint64)");
  });

  it("sendTipAtomic encodes update(address,bytes,uint256,uint256,uint64)", () => {
    const tx = sendTipAtomic(FLOW_PROXY);
    expect(tx).toContain("update(address,bytes,uint256,uint256,uint64)");
  });

  it("unwrapFlowAtomic encodes update(address,bytes,uint256,uint256,uint64)", () => {
    const tx = unwrapFlowAtomic(FLOW_PROXY);
    expect(tx).toContain("update(address,bytes,uint256,uint256,uint64)");
  });

  it("claimBatchAtomic encodes update(address,bytes,uint256,uint256,uint64)", () => {
    const tx = claimBatchAtomic(FLOW_PROXY);
    expect(tx).toContain("update(address,bytes,uint256,uint256,uint64)");
  });
});

// ---------------------------------------------------------------------------
// Token address baked into templates
// ---------------------------------------------------------------------------

describe("atomic-transactions — tokenAddrHex baked into checkpoint call", () => {
  it("updateCheckpointViaCoa takes tokenAddrHex as Cadence tx arg (not baked)", () => {
    // This template keeps tokenAddrHex as a Cadence tx arg (flexible for any token)
    const tx = updateCheckpointViaCoa();
    expect(tx).toContain("tokenAddrHex");
  });

  it("wrapFlowAtomic bakes FLOW_PROXY into checkpoint token address", () => {
    const tx = wrapFlowAtomic(FLOW_PROXY);
    expect(tx).toContain(FLOW_PROXY);
  });

  it("wrapFlowAtomic bakes MUSDC_PROXY when called with mUSDC proxy", () => {
    const tx = wrapFlowAtomic(MUSDC_PROXY);
    expect(tx).toContain(MUSDC_PROXY);
  });

  it("sendTipAtomic bakes FLOW_PROXY into checkpoint call", () => {
    const tx = sendTipAtomic(FLOW_PROXY);
    expect(tx).toContain(FLOW_PROXY);
  });

  it("unwrapFlowAtomic bakes FLOW_PROXY into both janus call and checkpoint call", () => {
    const tx = unwrapFlowAtomic(FLOW_PROXY);
    const occurrences = (tx.match(new RegExp(FLOW_PROXY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2); // janus call + checkpoint call
  });

  it("claimBatchAtomic bakes FLOW_PROXY into janus claimBatch and checkpoint calls", () => {
    const tx = claimBatchAtomic(FLOW_PROXY);
    expect(tx).toContain(FLOW_PROXY);
  });
});

// ---------------------------------------------------------------------------
// Template-specific structural checks
// ---------------------------------------------------------------------------

describe("wrapFlowAtomic structure", () => {
  it("imports FungibleToken and FlowToken for FLOW vault access", () => {
    const tx = wrapFlowAtomic(FLOW_PROXY);
    expect(tx).toContain("import FungibleToken from");
    expect(tx).toContain("import FlowToken from");
  });

  it("withdraws from /storage/flowTokenVault", () => {
    const tx = wrapFlowAtomic(FLOW_PROXY);
    expect(tx).toContain("/storage/flowTokenVault");
  });

  it("deposits to COA before calling wrapWithProof", () => {
    const tx = wrapFlowAtomic(FLOW_PROXY);
    expect(tx).toContain("coa.deposit");
  });

  it("asserts EVM.Status.successful for both wrap and checkpoint calls", () => {
    const tx = wrapFlowAtomic(FLOW_PROXY);
    const count = (tx.match(/EVM\.Status\.successful/g) ?? []).length;
    expect(count).toBe(2);
  });
});

describe("sendTipAtomic structure", () => {
  it("has janusProxyHex as a Cadence runtime arg (not baked in)", () => {
    const tx = sendTipAtomic(FLOW_PROXY);
    expect(tx).toContain("janusProxyHex: String");
    expect(tx).toContain("EVM.addressFromString(janusProxyHex)");
  });

  it("asserts success for both transfer and checkpoint calls", () => {
    const tx = sendTipAtomic(FLOW_PROXY);
    const count = (tx.match(/EVM\.Status\.successful/g) ?? []).length;
    expect(count).toBe(2);
  });
});

describe("claimBatchAtomic structure", () => {
  it("calls drainAll on ShieldedInbox first", () => {
    const tx = claimBatchAtomic(FLOW_PROXY);
    expect(tx).toContain(SHIELDED_INBOX_ADDRESS);
    expect(tx).toContain("drainAll()");
  });

  it("drainAll is non-fatal (result discarded)", () => {
    const tx = claimBatchAtomic(FLOW_PROXY);
    // Drain result is discarded with `let _ =`
    expect(tx).toContain("let _ = self.coa.call");
  });

  it("encodes claimBatch(uint256[6],uint256[8]) ABI", () => {
    const tx = claimBatchAtomic(FLOW_PROXY);
    expect(tx).toContain("claimBatch(uint256[6],uint256[8])");
  });

  it("asserts success for claimBatch and checkpoint (2 assertions)", () => {
    const tx = claimBatchAtomic(FLOW_PROXY);
    const count = (tx.match(/EVM\.Status\.successful/g) ?? []).length;
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// cadenceTx namespace bundle
// ---------------------------------------------------------------------------

describe("cadenceTx namespace — atomic templates exposed", () => {
  it("exposes wrapFlowAtomic", () => {
    expect(typeof cadenceTx.wrapFlowAtomic).toBe("function");
  });
  it("exposes sendTipAtomic", () => {
    expect(typeof cadenceTx.sendTipAtomic).toBe("function");
  });
  it("exposes unwrapFlowAtomic", () => {
    expect(typeof cadenceTx.unwrapFlowAtomic).toBe("function");
  });
  it("exposes claimBatchAtomic", () => {
    expect(typeof cadenceTx.claimBatchAtomic).toBe("function");
  });

  it("cadenceTx.wrapFlowAtomic produces same output as named export", () => {
    expect(cadenceTx.wrapFlowAtomic(FLOW_PROXY)).toBe(wrapFlowAtomic(FLOW_PROXY));
  });

  it("cadenceTx.sendTipAtomic produces same output as named export", () => {
    expect(cadenceTx.sendTipAtomic(MUSDC_PROXY)).toBe(sendTipAtomic(MUSDC_PROXY));
  });
});
