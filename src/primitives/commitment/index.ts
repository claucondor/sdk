/**
 * @claucondor/commitment — 2-generator Pedersen commitment on BabyJubJub
 *
 * Provides the classical Pedersen commitment scheme for additive privacy accumulators:
 *
 *   Commit(v, r) := [v]·G + [r]·H
 *
 * where G and H are independent generators on BabyJubJub, H derived via NUMS
 * (SHA-256 hash-to-scalar). The scheme is additively homomorphic:
 *
 *   Commit(v1, r1) + Commit(v2, r2) = Commit(v1+v2, r1+r2)
 *
 * @example
 * ```ts
 * import { commit, addCommits, isIdentity, SUBORDER } from "@claucondor/commitment";
 *
 * // Compute two commitments
 * const C1 = commit(1000n, 42n);
 * const C2 = commit(500n,  99n);
 *
 * // Homomorphic addition
 * const sum = addCommits(C1, C2);
 *
 * // Verify: sum == Commit(1500, 141)
 * import { pointsEqual } from "@claucondor/commitment";
 * const direct = commit(1500n, 141n);
 * console.log(pointsEqual(sum, direct)); // true
 * ```
 */

// Core commitment operations
export {
  commit,
  addCommits,
  negateCommit,
  subCommits,
  isIdentity,
  pointsEqual,
} from "./commitment.js";

// Curve constants and arithmetic primitives
export {
  P,
  A,
  D,
  SUBORDER,
  GX,
  GY,
  HX,
  HY,
  H_SEED_HASH,
  H_SCALAR,
  IDENTITY,
  pointAdd,
  pointMul,
  isOnCurve,
  deriveH,
} from "./generators.js";

// Self-test
export { verifyHomomorphism } from "./verify.js";

// Type export
export type { Point } from "./commitment.js";
