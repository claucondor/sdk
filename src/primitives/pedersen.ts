/**
 * primitives/pedersen.ts — Pedersen commitments on BabyJubJub
 *
 * Provides:
 *  - computeCommitment: off-chain Pedersen hash using circomlibjs
 *  - addCommitmentsLocal / subCommitmentsLocal: homomorphic point addition
 *  - identityCommitment: zero-balance sentinel
 *  - FCL script strings for on-chain queries (Cadence testnet)
 *
 * The commitment scheme:
 *   C = Pedersen(value_bits[0..63] || blinding_bits[0..127])
 *   packed as 24 bytes little-endian: [value_LE_8] || [blinding_LE_16]
 *   matches the circomlib Pedersen(192) template used by the v2 circuit.
 *
 * Field prime: 21888242871839275222246405745257275088548364400416034343698204186575808495617
 */

import type { CommitmentXY } from "../types/commitment";
import { CURVE_P } from "../types/commitment";
import { negatePoint } from "./babyjub";

export { CURVE_P } from "../types/commitment";

// ---------------------------------------------------------------------------
// Deployed contract addresses
// ---------------------------------------------------------------------------

/** PedersenBabyJub.cdc on Flow Cadence testnet — canonical openjanus deployment */
export const PEDERSEN_CADENCE_ADDRESS = "0x28fef3d1d6a12800";

/** BabyJub.sol on Flow EVM testnet — referenced by the Cadence contract */
export const BABYJUB_EVM_ADDRESS = "0x2c40513b343B70f2A0B7e6Ad6F997DDa819D6f07";

/** Flow testnet access node */
export const FLOW_TESTNET_ACCESS_NODE = "https://rest-testnet.onflow.org";

// ---------------------------------------------------------------------------
// WASM cache — circomlibjs init is expensive (~500ms), cache instances
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pedersenHash: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _babyJub: any = null;

async function getPedersenHash() {
  if (!_pedersenHash) {
    const { buildPedersenHash } = await import("circomlibjs");
    _pedersenHash = await buildPedersenHash();
  }
  return _pedersenHash;
}

async function getBabyJub() {
  if (!_babyJub) {
    const { buildBabyjub } = await import("circomlibjs");
    _babyJub = await buildBabyjub();
  }
  return _babyJub;
}

// ---------------------------------------------------------------------------
// Core: Pedersen commitment
// ---------------------------------------------------------------------------

/**
 * Compute a Pedersen commitment C = Pedersen(value, blinding) on BabyJubJub.
 *
 * v0.3 packing format (circomlib Pedersen(192) template — 24-byte buffer):
 *   bytes [0..7]   — value as 64-bit little-endian
 *   bytes [8..23]  — blinding as 128-bit little-endian
 *
 * Constraints:
 *   - value must be in [0, 2^64)
 *   - blinding must be in [0, 2^128)
 *
 * @param value    Token amount to commit to (max 2^64-1 for v0.3 circuits)
 * @param blinding 128-bit blinding factor (must be randomly generated; store it!)
 * @returns        BabyJubJub point (x, y) as bigints
 *
 * @deprecated Use computeCommitmentV05 for v0.5+ circuits (supports 2^128 values).
 */
export async function computeCommitment(
  value: bigint,
  blinding: bigint
): Promise<CommitmentXY> {
  if (value < 0n || value >= (1n << 64n)) {
    throw new RangeError(`computeCommitment: value must be in [0, 2^64), got ${value}`);
  }
  if (blinding < 0n || blinding >= (1n << 128n)) {
    throw new RangeError(
      `computeCommitment: blinding must be in [0, 2^128), got ${blinding}`
    );
  }

  const pedersenHash = await getPedersenHash();
  const babyJub = await getBabyJub();
  const F = babyJub.F;

  const buf = Buffer.alloc(24, 0);

  let v = value;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }

  let b = blinding;
  for (let i = 8; i < 24; i++) {
    buf[i] = Number(b & 0xffn);
    b >>= 8n;
  }

  const hash = pedersenHash.hash(buf);
  const point = babyJub.unpackPoint(hash);

  return {
    x: F.toObject(point[0]) as bigint,
    y: F.toObject(point[1]) as bigint,
  };
}

/**
 * Compute a v0.5 Pedersen commitment C = Pedersen(value, blinding) on BabyJubJub.
 *
 * v0.5 packing format (circomlib Pedersen(256) template — 32-byte buffer):
 *   bytes [0..15]  — value as 128-bit little-endian
 *   bytes [16..31] — blinding as 128-bit little-endian
 *
 * This matches the circuit packing in amount_disclose.circom v0.5 and
 * confidential_transfer.circom v0.5 (both use Pedersen(256) with 128-bit value
 * concatenated with 128-bit blinding).
 *
 * Constraints:
 *   - value must be in [0, 2^128)
 *   - blinding must be in [0, 2^128)
 *
 * @param value    Token amount to commit to (up to 2^128-1)
 * @param blinding 128-bit blinding factor (must be randomly generated; store it!)
 * @returns        BabyJubJub point (x, y) as bigints
 */
export async function computeCommitmentV05(
  value: bigint,
  blinding: bigint
): Promise<CommitmentXY> {
  if (value < 0n || value >= (1n << 128n)) {
    throw new RangeError(`computeCommitmentV05: value must be in [0, 2^128), got ${value}`);
  }
  if (blinding < 0n || blinding >= (1n << 128n)) {
    throw new RangeError(
      `computeCommitmentV05: blinding must be in [0, 2^128), got ${blinding}`
    );
  }

  const pedersenHash = await getPedersenHash();
  const babyJub = await getBabyJub();
  const F = babyJub.F;

  // 32-byte buffer: 16 bytes value (LE) + 16 bytes blinding (LE)
  const buf = Buffer.alloc(32, 0);

  let v = value;
  for (let i = 0; i < 16; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }

  let b = blinding;
  for (let i = 16; i < 32; i++) {
    buf[i] = Number(b & 0xffn);
    b >>= 8n;
  }

  const hash = pedersenHash.hash(buf);
  const point = babyJub.unpackPoint(hash);

  return {
    x: F.toObject(point[0]) as bigint,
    y: F.toObject(point[1]) as bigint,
  };
}

// ---------------------------------------------------------------------------
// Homomorphic operations (local, uses circomlibjs addPoint)
// ---------------------------------------------------------------------------

/**
 * Add two Pedersen commitment points homomorphically.
 * add(Pedersen(a, r1), Pedersen(b, r2)) = Pedersen(a+b, r1+r2)
 */
export async function addCommitmentsLocal(
  c1: CommitmentXY,
  c2: CommitmentXY
): Promise<CommitmentXY> {
  const babyJub = await getBabyJub();
  const F = babyJub.F;

  const p1 = [F.e(c1.x), F.e(c1.y)];
  const p2 = [F.e(c2.x), F.e(c2.y)];

  const result = babyJub.addPoint(p1, p2);
  return {
    x: F.toObject(result[0]) as bigint,
    y: F.toObject(result[1]) as bigint,
  };
}

/**
 * Subtract two Pedersen commitment points: c1 - c2 = c1 + negate(c2)
 */
export async function subCommitmentsLocal(
  c1: CommitmentXY,
  c2: CommitmentXY
): Promise<CommitmentXY> {
  const negC2 = negatePoint(c2.x, c2.y);
  return addCommitmentsLocal(c1, negC2);
}

/**
 * Negate a Pedersen commitment: negate((x, y)) = (P - x, y)
 */
export function negateCommitment(c: CommitmentXY): CommitmentXY {
  return {
    x: c.x === 0n ? 0n : CURVE_P - c.x,
    y: c.y,
  };
}

/**
 * Return the identity commitment (0, 1) — represents zero balance.
 */
export function identityCommitment(): CommitmentXY {
  return { x: 0n, y: 1n };
}

/**
 * Check if a commitment is the identity element (zero balance).
 */
export function isIdentityCommitment(c: CommitmentXY): boolean {
  return c.x === 0n && c.y === 1n;
}

// ---------------------------------------------------------------------------
// FCL script strings — query PedersenBabyJub.cdc on Cadence testnet
// ---------------------------------------------------------------------------

export const SCRIPT_IDENTITY = `
import PedersenBabyJub from 0x28fef3d1d6a12800

access(all) fun main(): {String: UInt256} {
    return PedersenBabyJub.identity()
}
`;

export const SCRIPT_NEGATE = `
import PedersenBabyJub from 0x28fef3d1d6a12800

access(all) fun main(x: UInt256, y: UInt256): {String: UInt256} {
    return PedersenBabyJub.negate({"x": x, "y": y})
}
`;

export const SCRIPT_IS_IDENTITY = `
import PedersenBabyJub from 0x28fef3d1d6a12800

access(all) fun main(x: UInt256, y: UInt256): Bool {
    return PedersenBabyJub.isIdentity({"x": x, "y": y})
}
`;

// ---------------------------------------------------------------------------
// Helper: convert commitment to string form for FCL arguments
// ---------------------------------------------------------------------------

/**
 * Convert a CommitmentXY to string-form UInt256 values for FCL arguments.
 */
export function commitmentToFclArgs(c: CommitmentXY): { x: string; y: string } {
  return { x: c.x.toString(), y: c.y.toString() };
}
