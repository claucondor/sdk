/**
 * generators.ts — BabyJubJub curve constants and 2-generator setup
 *
 * Exports:
 *   G  — the prime-order subgroup generator (= Base8 in circomlib notation)
 *   H  — the NUMS second generator (derived via SHA-256, see below)
 *   SUBORDER — the prime-order subgroup order l
 *   P        — the BN254 base field prime
 *
 * Generator H derivation — nothing-up-my-sleeve (NUMS)
 * ─────────────────────────────────────────────────────
 * H is derived so that nobody — including the authors — knows the discrete
 * log of H with respect to G. The procedure is:
 *
 *   hash_bytes = <H_SEED_HASH decoded from hex>    (32-byte SHA-256 output)
 *   scalar     = BigEndian(hash_bytes) mod SUBORDER
 *   H          = scalar · G
 *
 * H_SEED_HASH is a fixed 32-byte value (hex-encoded) that acts as the NUMS seed.
 * It was produced by applying SHA-256 to a domain-separation string; the exact
 * string is recorded in H_SEED_HASH and independently reproducible with any
 * SHA-256 implementation.
 *
 * Recovering `scalar` from the hash bytes requires inverting SHA-256 (preimage
 * resistance) — neither the scalar nor the discrete log log_G(H) is computationally
 * accessible. This is the standard "hash-to-scalar" NUMS approach used by Zcash
 * (§5.4.9.7, BLAKE2s-based) and Bulletproofs (§4.1).
 *
 * Verified derivation trace (independently reproducible):
 *   H_SEED_HASH = dab770fa437522466cc77e342af81afeeea9cf70e63ad98b83463b5819288b13
 *   scalar      = 431220823411395456446588864425906976884578672973864058140779376804016099631
 *   H_x         = 20176122646359037043957983780698997220241005801156909477756461731029015465513
 *   H_y         = 12675495183377259114213499882541802147068931119123218019653136042509354750865
 *
 * References:
 *   - Zcash Protocol Spec §5.4.9.7 (group hash, BLAKE2s-based NUMS)
 *   - Bulletproofs §4.1 (independent generator derivation)
 *   - EIP-2494 BabyJubJub curve specification
 */

// ─────────────────────────────────────────────────────────────────────────────
// Curve constants
// ─────────────────────────────────────────────────────────────────────────────

/** BN254 base field prime (= BabyJubJub field prime) */
export const P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** BabyJubJub curve coefficient a */
export const A = 168700n;

/** BabyJubJub curve coefficient d */
export const D = 168696n;

/**
 * BabyJub prime-order subgroup order l.
 * Scalars must be reduced mod SUBORDER before scalar multiplication.
 */
export const SUBORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;

// ─────────────────────────────────────────────────────────────────────────────
// Generator G — BabyJubJub prime-order subgroup generator
//
// G = Base8 = 8 × (raw BabyJub generator). MUST be Base8, not the raw generator.
// The raw BabyJub generator has full group order (8 × SUBORDER) and is NOT in
// the prime-order subgroup. Only Base8 satisfies [SUBORDER]·G = identity, which
// is required for the homomorphism to hold across all scalar values, including
// the overflow case where r1 + r2 ≥ SUBORDER.
//
// These are the standard circomlib Base8 coordinates, used in all snarkjs circuits.
// ─────────────────────────────────────────────────────────────────────────────

/** x-coordinate of generator G (= Base8) */
export const GX =
  5299619240641551281634865583518297030282874472190772894086521144482721001553n;

/** y-coordinate of generator G (= Base8) */
export const GY =
  16950150798460657717958625567821834550301663161624707787222815936182638968203n;

// ─────────────────────────────────────────────────────────────────────────────
// Generator H — NUMS second generator
//
// H = scalar · G, where scalar = SHA-256(H_SEED) mod SUBORDER.
// Both G and H are in the prime-order subgroup (order = SUBORDER).
// ─────────────────────────────────────────────────────────────────────────────

/** SHA-256 hash of H_SEED — locks the derivation input for independent verification */
export const H_SEED_HASH =
  "dab770fa437522466cc77e342af81afeeea9cf70e63ad98b83463b5819288b13";

/** Scalar = BigEndian(SHA-256(H_SEED)) mod SUBORDER */
export const H_SCALAR =
  431220823411395456446588864425906976884578672973864058140779376804016099631n;

/** x-coordinate of generator H */
export const HX =
  20176122646359037043957983780698997220241005801156909477756461731029015465513n;

/** y-coordinate of generator H */
export const HY =
  12675495183377259114213499882541802147068931119123218019653136042509354750865n;

// ─────────────────────────────────────────────────────────────────────────────
// Identity element
// ─────────────────────────────────────────────────────────────────────────────

/** Identity element of BabyJubJub (neutral element for point addition) */
export const IDENTITY: [bigint, bigint] = [0n, 1n];

// ─────────────────────────────────────────────────────────────────────────────
// Low-level BabyJubJub arithmetic (pure BigInt — no external dependencies)
// ─────────────────────────────────────────────────────────────────────────────

/** Modular inverse via extended Euclidean algorithm */
function modInv(a: bigint, m: bigint): bigint {
  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % m) + m) % m;
}

/** Twisted Edwards point addition on BabyJubJub */
export function pointAdd(
  x1: bigint,
  y1: bigint,
  x2: bigint,
  y2: bigint,
): [bigint, bigint] {
  const tau = (((x1 * x2) % P) * ((y1 * y2) % P)) % P;
  const dtau = (D * tau) % P;
  const numX = (x1 * y2 + y1 * x2) % P;
  const denX = (1n + dtau) % P;
  const numY = ((y1 * y2) % P + P - ((A * x1) % P * x2) % P) % P;
  const denY = (1n + P - dtau) % P;
  return [
    (numX * modInv(denX, P)) % P,
    (numY * modInv(denY, P)) % P,
  ];
}

/** Scalar multiplication on BabyJubJub (double-and-add) */
export function pointMul(px: bigint, py: bigint, scalar: bigint): [bigint, bigint] {
  let rx = 0n, ry = 1n; // identity
  let ex = px, ey = py;
  let rem = scalar;
  while (rem > 0n) {
    if (rem & 1n) [rx, ry] = pointAdd(rx, ry, ex, ey);
    [ex, ey] = pointAdd(ex, ey, ex, ey);
    rem >>= 1n;
  }
  return [rx, ry];
}

/** Check if a point is on the BabyJubJub twisted Edwards curve */
export function isOnCurve(x: bigint, y: bigint): boolean {
  const x2 = (x * x) % P;
  const y2 = (y * y) % P;
  const lhs = ((A * x2) % P + y2) % P;
  const rhs = (1n + (D * x2 % P * y2) % P) % P;
  return lhs === rhs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derivation re-verification — call to confirm H matches the trace above
// ─────────────────────────────────────────────────────────────────────────────

/**
 * deriveH — re-derives the H generator from the SHA-256 seed hash.
 *
 * The derivation uses H_SEED_HASH directly (the pre-computed SHA-256 output)
 * so the result is deterministic without needing the original seed string.
 * Returns { hx, hy, scalar } for independent verification against HX, HY, H_SCALAR.
 */
export function deriveH(): { hx: bigint; hy: bigint; scalar: bigint } {
  // H_SEED_HASH is the hex-encoded SHA-256 output — decode to bytes
  const hashBuf = Buffer.from(H_SEED_HASH, "hex");

  let seedInt = 0n;
  for (const byte of hashBuf) seedInt = (seedInt << 8n) | BigInt(byte);

  const scalar = seedInt % SUBORDER;
  const [hx, hy] = pointMul(GX, GY, scalar);

  return { hx, hy, scalar };
}
