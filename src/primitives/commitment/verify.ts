/**
 * verify.ts — self-test for the 2-generator Pedersen commitment scheme
 *
 * verifyHomomorphism() runs a suite of test vectors that confirm the additive
 * homomorphism holds: Commit(a,b) + Commit(c,d) == Commit(a+c, b+d).
 *
 * Call this function once during initialization or in a startup health check
 * to confirm the commitment arithmetic is working correctly.
 */

import { commit, addCommits, pointsEqual, isOnCurve } from "./commitment.js";
import { SUBORDER } from "./generators.js";

/**
 * verifyHomomorphism — verifies the additive homomorphism property
 *
 * Tests: Commit(a,b) + Commit(c,d) == Commit(a+c, b+d)
 * over several test vectors, including the scalar-overflow case where
 * (b+d) >= SUBORDER (which triggers modular reduction).
 *
 * Returns true if all assertions pass. Throws if any fails.
 */
export function verifyHomomorphism(): boolean {
  const vectors: Array<[bigint, bigint, bigint, bigint]> = [
    [1n, 1n, 2n, 3n],
    [0n, 1n, 5n, 7n],                       // zero-value left
    [5n, 7n, 0n, 1n],                       // zero-value right
    [0n, 0n, 0n, 0n],                       // double-zero (identity)
    [1000n, 12345n, 500n, 67890n],          // typical token amounts
    [
      100000000000000000000n,               // 100 × 10^18 (18-decimal token)
      SUBORDER - 1n,                        // max blinding
      1n,
      1n,                                   // r1+r2 = SUBORDER → reduces to 0
    ],
  ];

  for (const [v1, r1, v2, r2] of vectors) {
    const C1 = commit(v1, r1);
    const C2 = commit(v2, r2);
    const sum = addCommits(C1, C2);
    const direct = commit(
      (v1 + v2) % SUBORDER,
      (r1 + r2) % SUBORDER,
    );

    if (!pointsEqual(sum, direct)) {
      throw new Error(
        `Homomorphism FAILED for (v1=${v1}, r1=${r1}, v2=${v2}, r2=${r2}): ` +
          `sum=(${sum.x}, ${sum.y}) != direct=(${direct.x}, ${direct.y})`,
      );
    }

    if (!isOnCurve(sum.x, sum.y)) {
      throw new Error(
        `sum point off curve for (v1=${v1}, r1=${r1}, v2=${v2}, r2=${r2}): (${sum.x}, ${sum.y})`,
      );
    }
  }

  return true;
}
