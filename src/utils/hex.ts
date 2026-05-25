/**
 * utils/hex.ts — Pure hex / bigint conversion utilities
 *
 * No domain logic. No imports from other @openjanus/sdk modules.
 */

/**
 * Convert a bigint to a 0x-prefixed hex string with exactly `bytes` bytes (padded).
 *
 * @param n     BigInt value (must be >= 0)
 * @param bytes Number of bytes in the output (default: 32 for uint256)
 */
export function bigintToHex(n: bigint, bytes = 32): string {
  if (n < 0n) throw new RangeError(`bigintToHex: negative values not supported, got ${n}`);
  return "0x" + n.toString(16).padStart(bytes * 2, "0");
}

/**
 * Convert a 0x-prefixed hex string to BigInt.
 */
export function hexToBigint(hex: string): bigint {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length === 0) return 0n;
  return BigInt("0x" + h);
}

/**
 * Pad a hex string (with or without 0x prefix) to `bytes` bytes.
 * Returns a 0x-prefixed string.
 */
export function padHex(hex: string, bytes = 32): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return "0x" + h.padStart(bytes * 2, "0");
}

/**
 * Convert a decimal string (as returned by snarkjs) to BigInt.
 * Accepts both "123" and "0x..." formats.
 */
export function decimalToBigint(s: string): bigint {
  if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
  return BigInt(s);
}
