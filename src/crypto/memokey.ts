// ============================================================================
// WARNING — DO NOT MODIFY THIS FILE without a coordinated migration plan
// ============================================================================
//
// This file implements memokey derivation. Every byte of the algorithm is
// LOAD-BEARING for backward compatibility:
//
//   - MEMO_KEY_CONTEXT string MUST stay exactly as published
//       currently: "openjanus/memokey/v1"
//   - HKDF salt MUST stay exactly as published
//       currently: UTF-8("openjanus/derive-babyjub/v1")
//   - HKDF info MUST stay exactly as published
//       currently: UTF-8(MEMO_KEY_CONTEXT)
//   - HKDF output length MUST stay exactly as published
//       currently: 64 bytes (512 bits)
//   - Hash algorithm MUST stay exactly as published
//       currently: SHA-256
//   - BabyJub subgroup order MUST stay exactly as published
//       currently: 2736030358979909402780800718157159386076813972158567259200215660948447373041
//   - Field reduction MUST stay exactly as published
//       currently: bigEndianToBigInt(hkdfOutput) % BABYJUB_SUBGROUP_ORDER
//
// Changing ANY of these silently breaks ALL existing user snapshots,
// rendering shielded balances unrecoverable. Users would lose access
// to their funds — this is an irreversible data-loss event.
//
// If you genuinely need to change derivation (e.g., post-quantum upgrade):
//   1. Export the OLD derivation as `deriveMemoKeyV1(...)`
//   2. Add new `deriveMemoKeyV2(...)`
//   3. Provide migration tooling that re-encrypts V1 snapshots to V2
//   4. Coordinate with all users via announcement + UI prompt before shipping
//   5. Update the locked regression vectors in tests/unit/memokey-vectors.test.ts
//      to cover BOTH V1 and V2 — never delete V1 vectors while V1 snapshots exist
//
// Regression test: tests/unit/memokey-vectors.test.ts
//   Run: npm test -- memokey-vectors
//   A failing test here means the derivation was changed — STOP and revert.
//
// ============================================================================

/**
 * crypto/memokey.ts — BabyJub memo-key derivation from wallet signature.
 *
 * Re-exports the underlying deriveBabyJubKeypairFromBytes as the canonical
 * memokey derivation path. Any caller that wants a MemoKey for use with
 * JanusToken adapters should use deriveMemoKeyFromSignature.
 *
 * The sign-derive pattern:
 *   1. Prompt user to sign deterministic message with their wallet.
 *   2. Pass 65-byte signature to deriveMemoKeyFromSignature.
 *   3. Register keypair.pubkey via adapter.publishMemoKey.
 *   4. Keep keypair.privkey in memory for snapshot/note decryption.
 *
 * Same keypair is recovered on any device holding the same wallet key.
 */

export { deriveBabyJubKeypairFromBytes } from "./derive-keypair";
export type { BabyJubKeypair } from "./babyjub-keypair";

/** Canonical domain label for MemoKey derivation. */
export const MEMO_KEY_CONTEXT = "openjanus/memokey/v1" as const;

/**
 * Derive the MemoKey BabyJub keypair from a wallet signature.
 *
 * @param signatureBytes  65-byte EIP-191 wallet signature (r+s+v).
 * @returns               Deterministic BabyJub keypair.
 */
export async function deriveMemoKeyFromSignature(
  signatureBytes: Uint8Array
): Promise<import("./babyjub-keypair").BabyJubKeypair> {
  const { deriveBabyJubKeypairFromBytes } = await import("./derive-keypair");
  return deriveBabyJubKeypairFromBytes(signatureBytes, MEMO_KEY_CONTEXT);
}
