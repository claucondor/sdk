/**
 * primitives/pedersen.ts — Pedersen commitments on BabyJubJub (2-generator scheme)
 *
 * v0.7: delegates commitment computation to @openjanus/commitment, which
 * implements the classical 2-generator Pedersen scheme:
 *
 *   C = [v]·G + [r]·H
 *
 * where G = Base8 and H is a NUMS-derived second generator.  This is properly
 * additively homomorphic:
 *
 *   Commit(v1, r1) + Commit(v2, r2) = Commit(v1+v2, r1+r2)
 *
 * This replaces the prior windowed-hash Pedersen (circomlib Pedersen(192/256/512))
 * which was NOT homomorphic in this sense and caused "C_old mismatch" reverts
 * when the on-chain contract accumulated per-wrap commitment points.
 *
 * Export names are kept stable so all call sites compile without modification.
 *
 * Field prime: 21888242871839275222246405745257275088548364400416034343698204186575808495617
 */

import type { CommitmentXY } from "../types/commitment";
import { CURVE_P } from "../types/commitment";
import { negatePoint } from "./babyjub";
import {
  commit,
  addCommits,
  negateCommit,
  isIdentity as commitIsIdentity,
  SUBORDER,
} from "@openjanus/commitment";

export { CURVE_P } from "../types/commitment";

// ---------------------------------------------------------------------------
// Deployed contract addresses (retained for backward-compat consumers)
// ---------------------------------------------------------------------------

/** BabyJub.sol on Flow EVM testnet — canonical openjanus deployment */
export const BABYJUB_EVM_ADDRESS = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";

/** Flow testnet access node */
export const FLOW_TESTNET_ACCESS_NODE = "https://rest-testnet.onflow.org";

/** BabyJub subgroup order (2-gen blinding scalars live in [0, SUBORDER)) */
export { SUBORDER as BABYJUB_SUBGROUP_ORDER } from "@openjanus/commitment";

// ---------------------------------------------------------------------------
// Core: Pedersen commitment (2-gen: C = [v]·G + [r]·H)
// ---------------------------------------------------------------------------

/**
 * Compute a 2-generator Pedersen commitment C = [v]·G + [r]·H on BabyJubJub.
 *
 * v0.7 scheme (matches aggregate circuit constraints):
 *   v — token amount, must be in [0, 2^128)
 *   r — blinding scalar, must be in [0, SUBORDER) (252 bits)
 *
 * Additively homomorphic:
 *   computeCommitment(v1, r1) + computeCommitment(v2, r2) = computeCommitment(v1+v2, r1+r2)
 *
 * @param value    Token amount to commit (max 2^128-1)
 * @param blinding Blinding scalar in [0, SUBORDER)
 * @returns        BabyJubJub point (x, y) as bigints
 */
export async function computeCommitment(
  value: bigint,
  blinding: bigint
): Promise<CommitmentXY> {
  if (value < 0n || value >= 1n << 128n) {
    throw new RangeError(
      `computeCommitment: value must be in [0, 2^128), got ${value}`
    );
  }
  if (blinding < 0n || blinding >= SUBORDER) {
    throw new RangeError(
      `computeCommitment: blinding must be in [0, SUBORDER), got ${blinding}`
    );
  }
  const pt = commit(value, blinding);
  return { x: pt.x, y: pt.y };
}

/**
 * Aggregate a list of per-event Pedersen commitment points into a single point
 * by walking addCommitmentsLocal left-to-right.
 *
 * This is the same operation the on-chain JanusToken contract performs
 * (balanceOfCommitmentXY accumulates the running point sum).
 *
 * Returns the identity point (0, 1) for an empty list.
 */
export async function aggregateCommitmentPoints(
  commits: ReadonlyArray<CommitmentXY>
): Promise<CommitmentXY> {
  let acc: CommitmentXY = { x: 0n, y: 1n };
  for (const c of commits) {
    acc = await addCommitmentsLocal(acc, c);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Homomorphic operations (synchronous — pure arithmetic)
// ---------------------------------------------------------------------------

/**
 * Add two Pedersen commitment points homomorphically.
 * addCommits(Commit(a, r1), Commit(b, r2)) = Commit(a+b, r1+r2)
 */
export async function addCommitmentsLocal(
  c1: CommitmentXY,
  c2: CommitmentXY
): Promise<CommitmentXY> {
  const result = addCommits(c1, c2);
  return { x: result.x, y: result.y };
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
  const neg = negateCommit(c);
  return { x: neg.x, y: neg.y };
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
  return commitIsIdentity(c);
}

// ---------------------------------------------------------------------------
// FCL script strings — retained for backward compat (Cadence testnet)
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
