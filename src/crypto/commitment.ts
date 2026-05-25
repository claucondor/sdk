/**
 * crypto/commitment.ts — High-level commitment helpers
 *
 * Thin wrappers over primitives/pedersen that add:
 *  - Input validation with developer-friendly error messages
 *  - Brute-force balance decryption (for testing only)
 *  - Random blinding factor generation
 */

import type { CommitmentXY } from "../types/commitment";
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
 * Generate a cryptographically random 128-bit blinding factor.
 *
 * IMPORTANT: Store this value. You need it to:
 *   - Decrypt your balance (prove you own a commitment)
 *   - Generate ZK proofs for transfers
 */
export function generateBlinding(): bigint {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto !== "undefined") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Node.js fallback
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes } = require("crypto") as typeof import("crypto");
    const rand = randomBytes(16);
    for (let i = 0; i < 16; i++) bytes[i] = rand[i];
  }

  let blinding = 0n;
  for (let i = 0; i < 16; i++) {
    blinding = (blinding << 8n) | BigInt(bytes[i]);
  }
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
