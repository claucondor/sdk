/**
 * crypto/commitment.ts — High-level commitment helpers
 *
 * Thin wrappers over primitives/pedersen that add:
 *  - Input validation with developer-friendly error messages
 *  - Brute-force balance decryption (for testing only)
 *  - Random blinding factor generation
 *
 * v0.7: generateBlinding produces a full 252-bit scalar (SUBORDER range)
 * to match the aggregate circuit's blinding constraint (Num2Bits(252)).
 */

import type { CommitmentXY } from "../types/commitment";
import { SUBORDER } from "@openjanus/commitment";
import {
  computeCommitment,
  addCommitmentsLocal,
  negateCommitment,
  identityCommitment,
  isIdentityCommitment,
} from "../primitives/pedersen";

// Re-export the primitives for convenience
export {
  computeCommitment,
  addCommitmentsLocal as addCommitments,
  negateCommitment,
  identityCommitment,
  isIdentityCommitment,
} from "../primitives/pedersen";

/**
 * Generate a cryptographically random blinding scalar in [1, SUBORDER).
 *
 * v0.7: generates a full 252-bit scalar to match the aggregate circuit's
 * Num2Bits(252) blinding constraint. The prior 128-bit range was too narrow
 * for accumulated blindings from multiple received notes.
 *
 * IMPORTANT: Store this value. You need it to:
 *   - Decrypt your balance (prove you own a commitment)
 *   - Generate ZK proofs for transfers
 */
export function generateBlinding(): bigint {
  // Generate 32 random bytes (256 bits), reduce mod SUBORDER to stay in range,
  // ensure non-zero (SUBORDER is ~252 bits so mod rarely produces 0).
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto !== "undefined") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Node.js fallback
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes } = require("crypto") as typeof import("crypto");
    const rand = randomBytes(32);
    for (let i = 0; i < 32; i++) bytes[i] = rand[i];
  }

  let scalar = 0n;
  for (let i = 0; i < 32; i++) {
    scalar = (scalar << 8n) | BigInt(bytes[i]);
  }

  // Reduce mod SUBORDER, ensure non-zero
  let blinding = scalar % SUBORDER;
  if (blinding === 0n) blinding = 1n;
  return blinding;
}

/**
 * Decrypt a balance from a commitment by brute-force search.
 *
 * ONLY for testing with small balances (O(maxValue) operations).
 * Production apps must store the (value, blinding) pair at mint/wrap time.
 *
 * @param commit    On-chain commitment (x, y)
 * @param blinding  Known blinding factor used when creating the commitment
 * @param maxValue  Maximum value to search (default: 10000)
 * @returns         The hidden balance, or null if not found in [0, maxValue]
 */
export async function decryptBalance(
  commit: CommitmentXY,
  blinding: bigint,
  maxValue = 10000n
): Promise<bigint | null> {
  for (let v = 0n; v <= maxValue; v++) {
    const candidate = await computeCommitment(v, blinding);
    if (candidate.x === commit.x && candidate.y === commit.y) {
      return v;
    }
  }
  return null;
}

/** Re-export for external use */
export type { CommitmentXY };
void identityCommitment;
void isIdentityCommitment;
