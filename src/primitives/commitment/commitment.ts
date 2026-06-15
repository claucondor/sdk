/**
 * commitment.ts — 2-generator Pedersen commitment on BabyJubJub
 *
 * Implements the classical Pedersen commitment scheme:
 *
 *   Commit(v, r) := [v]·G + [r]·H
 *
 * where G and H are independent generators on BabyJubJub with computationally
 * inaccessible discrete log relationship (NUMS derivation — see generators.ts).
 *
 * Properties:
 *   - Computationally binding  (finding (v', r') ≠ (v, r) with same commitment
 *     requires solving the elliptic curve discrete log problem)
 *   - Perfectly hiding          (every curve point is equally likely as a
 *     commitment for any value, with a uniformly random blinding r)
 *   - Additively homomorphic:
 *       Commit(v1, r1) + Commit(v2, r2) = Commit(v1+v2, r1+r2)
 *
 * The homomorphism is the core property that enables additive privacy accumulators:
 * after N incoming commitments, the on-chain sum equals Commit(Σv_i, Σr_i mod l),
 * which the prover can satisfy with running sums (Σv_i, Σr_i mod l).
 *
 * Security notes:
 *   - v and r are field elements mod SUBORDER (~252 bits). Token amounts use 128
 *     bits for v; r should be a cryptographically random 252-bit scalar.
 *   - No subgroup attack risk: G and H are both in the prime-order subgroup by
 *     construction (scalar · G where scalar < SUBORDER).
 *   - Do NOT reuse blinding factors across commitments.
 *   - Commit(v, 0) = [v]·G — zero blinding reveals value structure. SDK must
 *     enforce r ≠ 0 in production.
 */

export type Point = { x: bigint; y: bigint };

import {
  GX, GY, HX, HY, P, SUBORDER,
  pointAdd, pointMul, isOnCurve, IDENTITY,
} from "./generators.js";

// ─────────────────────────────────────────────────────────────────────────────
// Core commitment operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * commit — compute Pedersen commitment C = [v]·G + [r]·H
 *
 * @param v  Value to commit (token amounts should be in [0, 2^128) range)
 * @param r  Blinding factor (random scalar in [1, SUBORDER) for hiding)
 * @returns  BabyJubJub point representing the commitment
 */
export function commit(v: bigint, r: bigint): Point {
  const vG = pointMul(GX, GY, v % SUBORDER);
  const rH = pointMul(HX, HY, r % SUBORDER);
  const [cx, cy] = pointAdd(vG[0], vG[1], rH[0], rH[1]);
  return { x: cx, y: cy };
}

/**
 * addCommits — homomorphic addition of two commitments
 *
 * addCommits(Commit(v1,r1), Commit(v2,r2)) = Commit(v1+v2, r1+r2)
 *
 * This is the operation the on-chain contract performs when accumulating
 * incoming transfer commitments. The prover tracks (Σv_i mod l, Σr_i mod l).
 *
 * @param p1  First commitment point
 * @param p2  Second commitment point
 * @returns   Sum point on BabyJubJub
 */
export function addCommits(p1: Point, p2: Point): Point {
  const [rx, ry] = pointAdd(p1.x, p1.y, p2.x, p2.y);
  return { x: rx, y: ry };
}

/**
 * negateCommit — negate a commitment (for subtraction)
 *
 * In twisted Edwards coordinates: -(x, y) = (-x mod P, y)
 * This corresponds to negating both the value and blinding scalars mod l.
 *
 * @param p  Commitment point to negate
 * @returns  Negated point
 */
export function negateCommit(p: Point): Point {
  return {
    x: p.x === 0n ? 0n : P - p.x,
    y: p.y,
  };
}

/**
 * subCommits — homomorphic subtraction: p1 - p2
 *
 * subCommits(Commit(v1,r1), Commit(v2,r2)) = Commit(v1-v2, r1-r2) (mod l)
 *
 * @param p1  Minuend commitment
 * @param p2  Subtrahend commitment
 * @returns   Difference point
 */
export function subCommits(p1: Point, p2: Point): Point {
  return addCommits(p1, negateCommit(p2));
}

/**
 * isIdentity — check whether a commitment is the identity element (0, 1)
 *
 * The identity is the neutral element for commitment addition.
 * Commit(0, 0) = identity.
 */
export function isIdentity(p: Point): boolean {
  return p.x === IDENTITY[0] && p.y === IDENTITY[1];
}

/**
 * pointsEqual — structural equality of two commitment points
 */
export function pointsEqual(p1: Point, p2: Point): boolean {
  return p1.x === p2.x && p1.y === p2.y;
}

// Re-export isOnCurve for consumers who need to validate received points
export { isOnCurve, SUBORDER, P, GX, GY, HX, HY, IDENTITY };
