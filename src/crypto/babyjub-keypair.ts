/**
 * crypto/babyjub-keypair.ts — BabyJubJub keypair generation
 *
 * Generates ECDH-capable keypairs on the BabyJubJub subgroup. The privkey is a
 * scalar in [1, subOrder); the pubkey is privkey * BASE8 (the standard subgroup
 * generator used by circomlib's Pedersen/EdDSA primitives).
 *
 * Use cases:
 *   - Memo encryption (see encryptText/decryptText) — ECIES handshake.
 *   - Per-user ephemeral keys for ECDH-based shared secrets.
 *   - Any future shielded-state encryption that needs an asymmetric primitive
 *     compatible with the SDK's BabyJubJub circuit ecosystem.
 *
 * Security:
 *   - The privkey is generated via Node's crypto.randomBytes (CSPRNG).
 *   - Reduced modulo subOrder; bias is negligible (~2^-4 of one bit).
 *   - The pubkey is computed on the subgroup, so it is automatically of low
 *     cofactor — safe against small-subgroup attacks.
 *
 * Pubkey serialization:
 *   We return {x, y} as bigints. Callers that need to persist a pubkey on
 *   Cadence storage (e.g. as UInt256[2]) can convert directly via x/y getters.
 *
 * NON-GOAL: this is not a deterministic key derivation. Callers that want
 * deterministic per-account keys must derive privkey themselves (e.g. via
 * HKDF on a signed message) and call `pubkeyFromPrivkey()` directly.
 */

import type { Point } from "../types/commitment";
import { randomBabyJubScalar } from "./babyjub-utils";

export interface BabyJubKeypair {
  /** Private scalar in [1, subOrder). NEVER persist plaintext. */
  privkey: bigint;
  /** Public point = privkey * BASE8. Safe to publish on-chain. */
  pubkey: Point;
}

/**
 * Compute the pubkey for a given privkey scalar.
 *
 * @param privkey — scalar in [1, subOrder)
 * @returns pubkey = privkey * BASE8 (BabyJubJub subgroup generator).
 */
export async function pubkeyFromPrivkey(privkey: bigint): Promise<Point> {
  const { buildBabyjub } = (await import("circomlibjs")) as unknown as {
    buildBabyjub: () => Promise<{
      Base8: [Uint8Array, Uint8Array];
      mulPointEscalar: (p: [Uint8Array, Uint8Array], s: bigint) => [Uint8Array, Uint8Array];
      F: { toString: (x: Uint8Array) => string };
    }>;
  };
  const babyjub = await buildBabyjub();
  const point = babyjub.mulPointEscalar(babyjub.Base8, privkey);
  return {
    x: BigInt(babyjub.F.toString(point[0])),
    y: BigInt(babyjub.F.toString(point[1])),
  };
}

/**
 * Generate a fresh BabyJubJub keypair for ECIES / memo encryption.
 *
 * @returns {privkey, pubkey} — privkey is a fresh CSPRNG scalar.
 */
export async function generateBabyJubKeypair(): Promise<BabyJubKeypair> {
  const privkey = await randomBabyJubScalar();
  const pubkey = await pubkeyFromPrivkey(privkey);
  return { privkey, pubkey };
}

/**
 * ECDH shared secret = privkey * peerPubkey, returned as the x-coordinate
 * of the resulting BabyJubJub point.
 *
 * Both parties must agree on which x-coordinate to use (canonical order — we
 * always pick the responder's view). Symmetric: aliceShared(a, B) ==
 * bobShared(b, A) where A = a*G, B = b*G.
 *
 * @returns x-coordinate of the shared point as bigint (32-byte field element).
 */
export async function computeSharedSecret(
  privkey: bigint,
  peerPubkey: Point
): Promise<bigint> {
  const { buildBabyjub } = (await import("circomlibjs")) as unknown as {
    buildBabyjub: () => Promise<{
      mulPointEscalar: (p: [Uint8Array, Uint8Array], s: bigint) => [Uint8Array, Uint8Array];
      F: {
        e: (n: bigint) => Uint8Array;
        toString: (x: Uint8Array) => string;
      };
    }>;
  };
  const babyjub = await buildBabyjub();
  const peerPoint: [Uint8Array, Uint8Array] = [
    babyjub.F.e(peerPubkey.x),
    babyjub.F.e(peerPubkey.y),
  ];
  const shared = babyjub.mulPointEscalar(peerPoint, privkey);
  return BigInt(babyjub.F.toString(shared[0]));
}
