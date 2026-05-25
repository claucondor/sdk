/**
 * types/commitment.ts — Shared commitment and curve point types
 *
 * These types are used by primitives/babyjub, primitives/pedersen,
 * crypto/commitment, and tokens/*. Keep pure — no runtime code.
 */

/** BN254 scalar field prime P (= BabyJubJub base field prime) */
export const CURVE_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** A point on the BabyJubJub twisted Edwards curve (x, y in Fp) */
export interface Point {
  x: bigint;
  y: bigint;
}

/** Identity element for BabyJubJub addition: (0, 1) */
export const IDENTITY_POINT: Point = { x: 0n, y: 1n };

/**
 * A BabyJubJub Pedersen commitment point.
 * Alias for Point — named separately for semantic clarity in higher-level APIs.
 */
export type CommitmentXY = Point;

/**
 * Check if a point is the BabyJubJub identity element (0, 1).
 */
export function isIdentityPoint(p: Point): boolean {
  return p.x === 0n && p.y === 1n;
}
