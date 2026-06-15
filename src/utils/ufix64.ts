/**
 * utils/ufix64.ts — UFix64 conversion helpers for Flow Cadence transactions.
 *
 * UFix64 is the Flow/Cadence fixed-point type with 8 fractional digits.
 * These helpers convert raw bigint amounts (with arbitrary decimal precision)
 * to the "N.XXXXXXXX" string format that FCL's `t.UFix64` argument type expects.
 *
 * Promoted from private-tip-v1/web/lib/tip-actions.ts (lines 418-441).
 * Previously duplicated in every app that submitted Cadence transactions
 * with token amounts.
 *
 * @module @claucondor/sdk/utils
 */

/** FLOW scale factor: 1 FLOW = 10^18 attoflow */
const FLOW_SCALE = 10n ** 18n;

/**
 * Convert a raw bigint amount with `decimals` precision to a UFix64 string.
 *
 * UFix64 has exactly 8 fractional digits. This function handles:
 *   - decimals > 8 : scale down (divide by 10^(decimals-8)), loses precision below 8 dp
 *   - decimals < 8 : scale up  (multiply by 10^(8-decimals))
 *   - decimals = 8 : passthrough (e.g. MockFT which uses 8 decimal places)
 *
 * @param amount   Raw amount in smallest units (e.g. 1_00000000n = 1 MockFT if decimals=8)
 * @param decimals Number of decimal places for this token (e.g. 18 for FLOW, 8 for MockFT, 6 for mUSDC)
 * @returns        UFix64 string e.g. "1.00000000"
 *
 * @example
 *   rawToUFix64(100_000_000n, 8)  // "1.00000000" (1 MockFT, 8 decimals)
 *   rawToUFix64(1_000_000n, 6)    // "1.00000000" (1 mUSDC, 6 decimals)
 *   rawToUFix64(1_000000000000000000n, 18) // "1.00000000" (1 FLOW, 18 decimals)
 */
export function rawToUFix64(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const frac = amount % scale;
  let fracUfix64: bigint;
  if (decimals >= 8) {
    fracUfix64 = frac / (10n ** BigInt(decimals - 8));
  } else {
    fracUfix64 = frac * (10n ** BigInt(8 - decimals));
  }
  return `${whole}.${fracUfix64.toString().padStart(8, "0")}`;
}

/**
 * Convert an attoflow (wei) bigint to a UFix64 string for FLOW.
 *
 * FLOW uses 18 decimal places; UFix64 has 8 → divide by 10^10 to scale down.
 * This is a convenience wrapper around `rawToUFix64(amount, 18)`.
 *
 * @param attoflow Amount in attoflow (1 FLOW = 10^18 attoflow)
 * @returns        UFix64 string e.g. "1.50000000"
 *
 * @example
 *   flowToUFix64(1_500_000_000_000_000_000n) // "1.50000000"
 *   flowToUFix64(100_000_000_000_000_000n)   // "0.10000000"
 */
export function flowToUFix64(attoflow: bigint): string {
  return rawToUFix64(attoflow, 18);
}

/**
 * @deprecated Use `flowToUFix64` for FLOW amounts or `rawToUFix64(amount, decimals)`
 * for other tokens. This alias is kept for backward compatibility with code that
 * imported `toUFix64` from utility modules.
 */
export const toUFix64 = flowToUFix64;

export { FLOW_SCALE };
