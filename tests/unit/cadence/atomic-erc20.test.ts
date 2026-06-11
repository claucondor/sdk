/**
 * tests/unit/cadence/atomic-erc20.spec.ts
 *
 * Exhaustive unit tests for ERC20 atomic Cadence transaction templates:
 *   wrapErc20Atomic, sendTipErc20Atomic, unwrapErc20Atomic
 *
 * Tests verify:
 *   1. EVM.EVMBytes(value:) applied to all checkpoint [UInt8] → bytes encodings
 *   2. SHIELDED_CHECKPOINT_ADDRESS baked by default; custom override works
 *   3. update(address,bytes,uint256,uint256,uint64) ABI string present
 *   4. tokenAddrHex baked into checkpoint token arg
 *   5. Each template has the correct number of EVM.Status.successful assertions
 *   6. Templates are exposed on the cadenceTx namespace
 *   7. No old 3-arg checkpoint pattern (update(...,bytes,...) without address)
 *   8. Structural checks: imports, panic messages, arg names
 */

import { describe, it, expect } from "vitest";
import {
  wrapErc20Atomic,
  sendTipErc20Atomic,
  unwrapErc20Atomic,
  cadenceTx,
} from "../../../src/cadence/index";
import { SHIELDED_CHECKPOINT_ADDRESS } from "../../../src/network/contracts";

const MUSDC_PROXY    = "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d";
const MUSDC_UNDERLYING = "0xd49Ff950279841aaEcf642E85C3a0bBc1FB4B524";
const CUSTOM_CP      = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// ---------------------------------------------------------------------------
// EVM.EVMBytes guard
// ---------------------------------------------------------------------------

describe("ERC20 atomic templates — EVM.EVMBytes(value:) fix applied", () => {
  it("wrapErc20Atomic has EVM.EVMBytes(value:", () => {
    expect(wrapErc20Atomic(MUSDC_PROXY)).toContain("EVM.EVMBytes(value:");
  });

  it("sendTipErc20Atomic has EVM.EVMBytes(value:", () => {
    expect(sendTipErc20Atomic(MUSDC_PROXY)).toContain("EVM.EVMBytes(value:");
  });

  it("unwrapErc20Atomic has EVM.EVMBytes(value:", () => {
    expect(unwrapErc20Atomic(MUSDC_PROXY)).toContain("EVM.EVMBytes(value:");
  });

  it("wrapErc20Atomic has exactly 1 EVM.EVMBytes(value: call", () => {
    const count = (wrapErc20Atomic(MUSDC_PROXY).match(/EVM\.EVMBytes\(value:/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("sendTipErc20Atomic has exactly 1 EVM.EVMBytes(value: call", () => {
    const count = (sendTipErc20Atomic(MUSDC_PROXY).match(/EVM\.EVMBytes\(value:/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("unwrapErc20Atomic has exactly 1 EVM.EVMBytes(value: call", () => {
    const count = (unwrapErc20Atomic(MUSDC_PROXY).match(/EVM\.EVMBytes\(value:/g) ?? []).length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint contract address
// ---------------------------------------------------------------------------

describe("ERC20 atomic templates — checkpoint contract address", () => {
  it("wrapErc20Atomic uses SDK SHIELDED_CHECKPOINT_ADDRESS by default", () => {
    expect(wrapErc20Atomic(MUSDC_PROXY)).toContain(SHIELDED_CHECKPOINT_ADDRESS);
  });

  it("sendTipErc20Atomic uses SDK SHIELDED_CHECKPOINT_ADDRESS by default", () => {
    expect(sendTipErc20Atomic(MUSDC_PROXY)).toContain(SHIELDED_CHECKPOINT_ADDRESS);
  });

  it("unwrapErc20Atomic uses SDK SHIELDED_CHECKPOINT_ADDRESS by default", () => {
    expect(unwrapErc20Atomic(MUSDC_PROXY)).toContain(SHIELDED_CHECKPOINT_ADDRESS);
  });

  it("wrapErc20Atomic accepts custom checkpoint address override", () => {
    expect(wrapErc20Atomic(MUSDC_PROXY, CUSTOM_CP)).toContain(CUSTOM_CP);
    expect(wrapErc20Atomic(MUSDC_PROXY, CUSTOM_CP)).not.toContain(SHIELDED_CHECKPOINT_ADDRESS);
  });

  it("sendTipErc20Atomic accepts custom checkpoint address override", () => {
    expect(sendTipErc20Atomic(MUSDC_PROXY, CUSTOM_CP)).toContain(CUSTOM_CP);
    expect(sendTipErc20Atomic(MUSDC_PROXY, CUSTOM_CP)).not.toContain(SHIELDED_CHECKPOINT_ADDRESS);
  });

  it("unwrapErc20Atomic accepts custom checkpoint address override", () => {
    expect(unwrapErc20Atomic(MUSDC_PROXY, CUSTOM_CP)).toContain(CUSTOM_CP);
    expect(unwrapErc20Atomic(MUSDC_PROXY, CUSTOM_CP)).not.toContain(SHIELDED_CHECKPOINT_ADDRESS);
  });
});

// ---------------------------------------------------------------------------
// Multi-token ABI encoding
// ---------------------------------------------------------------------------

describe("ERC20 atomic templates — multi-token update ABI", () => {
  it("wrapErc20Atomic encodes update(address,bytes,uint256,uint256,uint64)", () => {
    expect(wrapErc20Atomic(MUSDC_PROXY)).toContain("update(address,bytes,uint256,uint256,uint64)");
  });

  it("sendTipErc20Atomic encodes update(address,bytes,uint256,uint256,uint64)", () => {
    expect(sendTipErc20Atomic(MUSDC_PROXY)).toContain("update(address,bytes,uint256,uint256,uint64)");
  });

  it("unwrapErc20Atomic encodes update(address,bytes,uint256,uint256,uint64)", () => {
    expect(unwrapErc20Atomic(MUSDC_PROXY)).toContain("update(address,bytes,uint256,uint256,uint64)");
  });
});

// ---------------------------------------------------------------------------
// tokenAddrHex baked into templates
// ---------------------------------------------------------------------------

describe("ERC20 atomic templates — tokenAddrHex baked into checkpoint call", () => {
  it("wrapErc20Atomic bakes MUSDC_PROXY into checkpoint token arg", () => {
    const tx = wrapErc20Atomic(MUSDC_PROXY);
    expect(tx).toContain(MUSDC_PROXY);
  });

  it("wrapErc20Atomic checkpoint token arg is baked even if different from proxyHex runtime arg", () => {
    // The Cadence runtime arg `proxyHex` is separate; the checkpoint uses the baked JS tokenAddrHex
    const tx = wrapErc20Atomic(MUSDC_PROXY);
    // Template has proxyHex as a runtime arg name
    expect(tx).toContain("proxyHex: String");
    // AND the baked token address appears in the checkpoint encode call
    expect(tx).toContain(MUSDC_PROXY);
  });

  it("sendTipErc20Atomic bakes MUSDC_PROXY into both transfer and checkpoint calls", () => {
    const tx = sendTipErc20Atomic(MUSDC_PROXY);
    const occurrences = (tx.match(new RegExp(MUSDC_PROXY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("unwrapErc20Atomic bakes MUSDC_PROXY into both unwrap and checkpoint calls", () => {
    const tx = unwrapErc20Atomic(MUSDC_PROXY);
    const occurrences = (tx.match(new RegExp(MUSDC_PROXY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("wrapErc20Atomic generates different templates for different token addresses", () => {
    const tx1 = wrapErc20Atomic(MUSDC_PROXY);
    const tx2 = wrapErc20Atomic("0x1111111111111111111111111111111111111111");
    expect(tx1).not.toBe(tx2);
  });
});

// ---------------------------------------------------------------------------
// Template structure: assertions, arg names, imports
// ---------------------------------------------------------------------------

describe("wrapErc20Atomic structure", () => {
  it("imports only EVM (no FungibleToken/FlowToken — ERC20 is pure EVM)", () => {
    const tx = wrapErc20Atomic(MUSDC_PROXY);
    expect(tx).toContain("import EVM from");
    expect(tx).not.toContain("import FungibleToken");
    expect(tx).not.toContain("import FlowToken");
  });

  it("has underlyingHex and proxyHex as separate runtime args", () => {
    const tx = wrapErc20Atomic(MUSDC_PROXY);
    expect(tx).toContain("underlyingHex: String");
    expect(tx).toContain("proxyHex: String");
  });

  it("approve call targets underlyingHex (not proxyHex)", () => {
    const tx = wrapErc20Atomic(MUSDC_PROXY);
    expect(tx).toContain("EVM.addressFromString(underlyingHex)");
  });

  it("wrap call targets proxyHex", () => {
    const tx = wrapErc20Atomic(MUSDC_PROXY);
    expect(tx).toContain("EVM.addressFromString(proxyHex)");
  });

  it("has 3 EVM.Status.successful assertions (approve, wrap, checkpoint)", () => {
    const count = (wrapErc20Atomic(MUSDC_PROXY).match(/EVM\.Status\.successful/g) ?? []).length;
    expect(count).toBe(3);
  });

  it("has encryptedSnapshotHex as a String runtime arg", () => {
    expect(wrapErc20Atomic(MUSDC_PROXY)).toContain("encryptedSnapshotHex: String");
  });

  it("uses prepare + execute block structure (not all in prepare)", () => {
    const tx = wrapErc20Atomic(MUSDC_PROXY);
    expect(tx).toContain("prepare(");
    expect(tx).toContain("execute {");
  });
});

describe("sendTipErc20Atomic structure", () => {
  it("imports only EVM", () => {
    const tx = sendTipErc20Atomic(MUSDC_PROXY);
    expect(tx).toContain("import EVM from");
    expect(tx).not.toContain("import FungibleToken");
  });

  it("has transferCalldataHex as runtime arg", () => {
    expect(sendTipErc20Atomic(MUSDC_PROXY)).toContain("transferCalldataHex: String");
  });

  it("does NOT have janusProxyHex as runtime arg (proxy is baked in)", () => {
    // Unlike sendTipAtomic which has janusProxyHex, the ERC20-specific template bakes the proxy
    expect(sendTipErc20Atomic(MUSDC_PROXY)).not.toContain("janusProxyHex");
  });

  it("has 2 EVM.Status.successful assertions (transfer, checkpoint)", () => {
    const count = (sendTipErc20Atomic(MUSDC_PROXY).match(/EVM\.Status\.successful/g) ?? []).length;
    expect(count).toBe(2);
  });

  it("panic message mentions send_tip_erc20_atomic", () => {
    expect(sendTipErc20Atomic(MUSDC_PROXY)).toContain("send_tip_erc20_atomic");
  });
});

describe("unwrapErc20Atomic structure", () => {
  it("imports only EVM", () => {
    const tx = unwrapErc20Atomic(MUSDC_PROXY);
    expect(tx).toContain("import EVM from");
    expect(tx).not.toContain("import FungibleToken");
  });

  it("has unwrapCalldataHex as runtime arg", () => {
    expect(unwrapErc20Atomic(MUSDC_PROXY)).toContain("unwrapCalldataHex: String");
  });

  it("has 2 EVM.Status.successful assertions (unwrap, checkpoint)", () => {
    const count = (unwrapErc20Atomic(MUSDC_PROXY).match(/EVM\.Status\.successful/g) ?? []).length;
    expect(count).toBe(2);
  });

  it("panic message mentions unwrap_erc20_atomic", () => {
    expect(unwrapErc20Atomic(MUSDC_PROXY)).toContain("unwrap_erc20_atomic");
  });
});

// ---------------------------------------------------------------------------
// No old 3-arg checkpoint pattern
// ---------------------------------------------------------------------------

describe("ERC20 atomic templates — no stale checkpoint API", () => {
  it("wrapErc20Atomic does not use old 3-arg update pattern (no update without address)", () => {
    // Old pattern: "update(bytes,uint256,uint256,uint64)" — no address first arg
    expect(wrapErc20Atomic(MUSDC_PROXY)).not.toContain("update(bytes,");
  });

  it("sendTipErc20Atomic does not use old 3-arg update pattern", () => {
    expect(sendTipErc20Atomic(MUSDC_PROXY)).not.toContain("update(bytes,");
  });

  it("unwrapErc20Atomic does not use old 3-arg update pattern", () => {
    expect(unwrapErc20Atomic(MUSDC_PROXY)).not.toContain("update(bytes,");
  });
});

// ---------------------------------------------------------------------------
// cadenceTx namespace — ERC20 templates exposed
// ---------------------------------------------------------------------------

describe("cadenceTx namespace — ERC20 atomic templates exposed", () => {
  it("exposes wrapErc20Atomic", () => {
    expect(typeof cadenceTx.wrapErc20Atomic).toBe("function");
  });

  it("exposes sendTipErc20Atomic", () => {
    expect(typeof cadenceTx.sendTipErc20Atomic).toBe("function");
  });

  it("exposes unwrapErc20Atomic", () => {
    expect(typeof cadenceTx.unwrapErc20Atomic).toBe("function");
  });

  it("cadenceTx.wrapErc20Atomic produces same output as named export", () => {
    expect(cadenceTx.wrapErc20Atomic(MUSDC_PROXY)).toBe(wrapErc20Atomic(MUSDC_PROXY));
  });

  it("cadenceTx.sendTipErc20Atomic produces same output as named export", () => {
    expect(cadenceTx.sendTipErc20Atomic(MUSDC_PROXY)).toBe(sendTipErc20Atomic(MUSDC_PROXY));
  });

  it("cadenceTx.unwrapErc20Atomic produces same output as named export", () => {
    expect(cadenceTx.unwrapErc20Atomic(MUSDC_PROXY)).toBe(unwrapErc20Atomic(MUSDC_PROXY));
  });
});

// ---------------------------------------------------------------------------
// Template balance (basic brace-count sanity)
// ---------------------------------------------------------------------------

describe("ERC20 atomic templates — balanced braces", () => {
  function countBraces(s: string): { open: number; close: number } {
    return {
      open:  (s.match(/\{/g) ?? []).length,
      close: (s.match(/\}/g) ?? []).length,
    };
  }

  it("wrapErc20Atomic has balanced braces", () => {
    const { open, close } = countBraces(wrapErc20Atomic(MUSDC_PROXY));
    expect(open).toBe(close);
  });

  it("sendTipErc20Atomic has balanced braces", () => {
    const { open, close } = countBraces(sendTipErc20Atomic(MUSDC_PROXY));
    expect(open).toBe(close);
  });

  it("unwrapErc20Atomic has balanced braces", () => {
    const { open, close } = countBraces(unwrapErc20Atomic(MUSDC_PROXY));
    expect(open).toBe(close);
  });
});

// ---------------------------------------------------------------------------
// Regression: underlying address NOT leaked into template name
// This guards against copy-paste confusion with MUSDC_UNDERLYING
// ---------------------------------------------------------------------------

describe("ERC20 atomic templates — address isolation", () => {
  it("wrapErc20Atomic tokenAddrHex=PROXY does not bake MUSDC_UNDERLYING", () => {
    // The underlying address is a runtime arg — not baked from JS
    expect(wrapErc20Atomic(MUSDC_PROXY)).not.toContain(MUSDC_UNDERLYING);
  });
});
