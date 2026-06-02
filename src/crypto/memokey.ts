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
