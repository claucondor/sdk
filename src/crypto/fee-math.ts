/**
 * crypto/fee-math.ts — Pure fee math helpers.
 *
 * These are the canonical formulae the v0.6 contracts use:
 *   fee = floor(gross * feeBps / 10000)
 *   net = gross - fee
 *
 * Used by orchestration to compute net amounts before binding proofs.
 * Re-exported at the top level for app code that wants to preview fees in UI.
 */

/**
 * Compute the net amount after fee deduction (for both wrap GROSS and unwrap CLAIMED).
 * @param gross   The full input amount.
 * @param feeBps  Fee rate in basis points (10 = 0.1%, 100 = 1%).
 * @returns       net = gross - floor(gross * feeBps / 10000)
 */
export function computeNetWrap(gross: bigint, feeBps: number): bigint {
  if (feeBps === 0) return gross;
  const fee = (gross * BigInt(feeBps)) / 10000n;
  return gross - fee;
}

/** Compute the fee that will be sent to feeRecipient for a wrap. */
export function computeWrapFee(gross: bigint, feeBps: number): bigint {
  if (feeBps === 0) return 0n;
  return (gross * BigInt(feeBps)) / 10000n;
}

/** Compute the net amount the recipient will receive after an unwrap. */
export function computeNetUnwrap(claimed: bigint, feeBps: number): bigint {
  if (feeBps === 0) return claimed;
  const fee = (claimed * BigInt(feeBps)) / 10000n;
  return claimed - fee;
}

/** Compute the fee that will be sent to feeRecipient for an unwrap. */
export function computeUnwrapFee(claimed: bigint, feeBps: number): bigint {
  if (feeBps === 0) return 0n;
  return (claimed * BigInt(feeBps)) / 10000n;
}
