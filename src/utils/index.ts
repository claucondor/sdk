/**
 * utils/index.ts — Pure utility exports
 *
 * These are stateless helpers with no domain logic.
 * Safe to import from any module without causing circular dependencies.
 */

export { bigintToHex, hexToBigint, padHex, decimalToBigint } from "./hex";
export { applyPiBSwap, evmProofToUint256Array } from "./pi-b-swap";
export { formatPoint, isValidFlowAddress, isValidFlowAmount, bigintReplacer } from "./format";
