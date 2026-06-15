/**
 * utils/index.ts — Pure utility exports
 *
 * These are stateless helpers with no domain logic.
 * Safe to import from any module without causing circular dependencies.
 */

export { bigintToHex, hexToBigint, padHex, decimalToBigint } from "./hex";
export { applyPiBSwap, evmProofToUint256Array } from "./pi-b-swap";
export { formatPoint, isValidFlowAddress, isValidFlowAmount, bigintReplacer } from "./format";

// ── Promoted workarounds ────────────────────────────────────────────────────

// W3 — UFix64 conversion helpers (promoted from tip-actions.ts:418-441)
export { rawToUFix64, flowToUFix64, toUFix64, FLOW_SCALE } from "./ufix64";

// W2 — Cadence address → EVM token identifier; ABI calldata pre-encoder
// W7 — encodeEVMCalldata (promoted from BatchClaimCTA.tsx:275-281)
export { cadenceAddrToEvmToken, encodeEVMCalldata } from "./evm-helpers";

// W1 — isFreshSlotCommit (promoted from tip-actions.ts:741-744)
// W5 — computeActualCOld (promoted from BatchClaimCTA.tsx:179-195)
export { isFreshSlotCommit, computeActualCOld, BABYJUB_SUBORDER } from "./fresh-slot";
