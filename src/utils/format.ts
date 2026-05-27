/**
 * utils/format.ts — Small formatters and validators.
 *
 * Stateless helpers for common Flow / BabyJub display + validation needs.
 */

import type { Point } from "../types/commitment";

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
