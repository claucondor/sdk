/**
 * crypto/babyjub-utils.ts — BabyJubJub randomness + FLOW unit conversion helpers
 *
 * Two recurring footguns these helpers address:
 *
 *   1. Random scalar generation
 *      Naive `randomBytes(32) mod F.p` produces values in BabyJubJub's base field
 *      (~2^254), but circomlib's `mulPointEscalar` decomposes scalars on the
 *      *subgroup* order (~2^250). A scalar > subOrder either fails witness
 *      generation silently or wraps non-deterministically. Use
 *      `randomBabyJubScalar()` — it mods by `babyjub.subOrder`, never by `F.p`.
 *
 *   2. FLOW unit conversion
 *      v0.3 JanusFlow takes wei (attoFLOW) on the EVM side directly — `wrap()`
 *      is payable so `msg.value` is the cleartext amount the circuit binds via
 *      AmountDisclose. `flowToWei` / `weiToFlow` keep whole-FLOW ↔ wei
 *      conversions explicit. (v0.2 had a separate small-int "claimedUnits"
 *      space that triggered audits-kb vuln 014; v0.3 removed that footgun by
 *      using wei everywhere.)
 */

import { randomBytes as nodeRandomBytes } from "crypto";

// ---------------------------------------------------------------------------
// FLOW unit constants and converters
// ---------------------------------------------------------------------------

/** Decimal places of FLOW in wei (matches Solidity SCALE = 1e18). */
export const FLOW_DECIMALS = 18;

/** SCALE = 10^FLOW_DECIMALS = 1e18 wei per whole FLOW. */
export const FLOW_SCALE = 10n ** BigInt(FLOW_DECIMALS);

/**
 * Convert whole-FLOW units (as used by the ZK circuits and the contract's
 * `wrap`/`unwrap` claimedUnits parameter) to wei (as msg.value).
 *
 * @example
 *   flowToWei(2n)   // 2_000000000000000000n
 *   flowToWei(0n)   // 0n
 */
export function flowToWei(flowUnits: bigint): bigint {
  return flowUnits * FLOW_SCALE;
}

/**
 * Convert wei to whole-FLOW units, truncating dust.
 *
 * Note: the on-chain `wrap` REJECTS any msg.value that is not a whole multiple
 * of SCALE (no dust accumulation). This converter does NOT enforce that —
 * use `assertWholeFlow(wei)` before sending if you want a loud failure.
 *
 * @example
 *   weiToFlow(2_000000000000000000n)  // 2n
 *   weiToFlow(2_500000000000000000n)  // 2n (truncated)
 */
export function weiToFlow(weiAmount: bigint): bigint {
  return weiAmount / FLOW_SCALE;
}

/**
 * Throw if `weiAmount` is not a whole multiple of SCALE.
 * Useful to fail fast before submitting a wrap that would revert on-chain.
 */
export function assertWholeFlow(weiAmount: bigint): void {
  if (weiAmount % FLOW_SCALE !== 0n) {
    throw new Error(
      `assertWholeFlow: ${weiAmount} wei is not a whole multiple of SCALE (${FLOW_SCALE}). JanusToken.wrap requires whole-FLOW amounts; refusing to submit.`
    );
  }
}

// ---------------------------------------------------------------------------
// BabyJubJub random scalar
// ---------------------------------------------------------------------------

/**
 * Generate a random scalar in `[1, babyjub.subOrder)` suitable for ElGamal
 * randomness or fresh ephemeral keys.
 *
 * Implementation detail: we sample 32 bytes, then reduce modulo `subOrder`
 * (~2^250), not `F.p` (~2^254). This matches the circuit's Num2Bits(253)
 * decomposition and `mulPointEscalar` expectations. Returns `1n` if the
 * sample reduces to zero.
 *
 * NOTE: bias from `raw mod subOrder` is negligible (~2^-4 over uniform).
 * For a strictly-uniform sampler, use rejection sampling on the leading bits.
 *
 * @returns Random bigint in `[1, subOrder)`.
 */
export async function randomBabyJubScalar(): Promise<bigint> {
  const { buildBabyjub } = (await import("circomlibjs")) as unknown as {
    buildBabyjub: () => Promise<{ subOrder: bigint }>;
  };
  const babyjub = await buildBabyjub();
  const ORDER: bigint = babyjub.subOrder;
  const bytes = nodeRandomBytes(32);
  const raw = BigInt("0x" + bytes.toString("hex"));
  const reduced = ((raw % ORDER) + ORDER) % ORDER;
  return reduced === 0n ? 1n : reduced;
}
