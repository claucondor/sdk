/**
 * utils/format.ts — Small formatters and validators.
 *
 * Stateless helpers for common Flow / BabyJub display + validation needs.
 */

import type { Point } from "../types/commitment";

// ---------------------------------------------------------------------------
// BigInt JSON serialization helper
// ---------------------------------------------------------------------------

/**
 * JSON replacer that serializes BigInt values as decimal strings.
 *
 * Use this with JSON.stringify when the object contains BigInt fields
 * (e.g., WrapOrchestrateResult, UnwrapOrchestrateResult, proof arrays).
 *
 * The SDK returns BigInt values in most result types. JavaScript's built-in
 * JSON.stringify throws `TypeError: Do not know how to serialize a BigInt`
 * on such objects. Pass this replacer as the second argument to avoid that.
 *
 * Deserialisation: use BigInt(str) on each field when reading back.
 * The PrivateTip frontend already does this (`.map(BigInt)` on proof arrays).
 *
 * @example
 *   import { bigintReplacer } from '@claucondor/sdk';
 *   const json = JSON.stringify(wrapResult, bigintReplacer, 2);
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * Format a BabyJubJub point as `(0x<x-hex>, 0x<y-hex>)` for logs / UI.
 */
export function formatPoint(p: Point): string {
  return `(0x${p.x.toString(16)}, 0x${p.y.toString(16)})`;
}

/**
 * Validate a Flow Cadence address. Accepts 0x followed by 16 hex digits.
 */
export function isValidFlowAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{16}$/.test(addr.trim());
}

/**
 * Validate a UFix64-style FLOW amount string. Accepts up to 18 fractional
 * digits and requires a positive value.
 *
 * NOTE: UFix64 on Cadence is exact to 8 fractional digits; this function
 * accepts up to 18 (the wei scale) so callers can validate higher-precision
 * input before truncating.
 */
export function isValidFlowAmount(amount: string): boolean {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(trimmed)) return false;
  return parseFloat(trimmed) > 0;
}
