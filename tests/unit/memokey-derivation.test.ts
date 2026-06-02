/**
 * Unit tests for memokey derivation.
 * Tests: same wallet sig → same memokey, idempotent. Different sigs → different keys.
 */

import { describe, it, expect } from "vitest";
import { deriveMemoKeyFromSignature, MEMO_KEY_CONTEXT } from "../../src/crypto/memokey";
import { deriveBabyJubKeypairFromBytes } from "../../src/crypto/derive-keypair";

// Deterministic 65-byte "signature" for testing (just random bytes, not real ECDSA)
const SIG_ALICE = new Uint8Array(65).fill(0xaa);
const SIG_BOB = new Uint8Array(65).fill(0xbb);

describe("deriveMemoKeyFromSignature — determinism", () => {
  it("same sig → same keypair (idempotent)", async () => {
    const kp1 = await deriveMemoKeyFromSignature(SIG_ALICE);
    const kp2 = await deriveMemoKeyFromSignature(SIG_ALICE);
    expect(kp1.privkey).toBe(kp2.privkey);
    expect(kp1.pubkey.x).toBe(kp2.pubkey.x);
    expect(kp1.pubkey.y).toBe(kp2.pubkey.y);
  });

  it("different sigs → different keypairs", async () => {
    const kpA = await deriveMemoKeyFromSignature(SIG_ALICE);
    const kpB = await deriveMemoKeyFromSignature(SIG_BOB);
    expect(kpA.privkey).not.toBe(kpB.privkey);
  });

  it("privkey is in valid BabyJub scalar range [1, subOrder)", async () => {
    const BABYJUB_ORDER =
      2736030358979909402780800718157159386076813972158567259200215660948447373041n;
    const kp = await deriveMemoKeyFromSignature(SIG_ALICE);
    expect(kp.privkey).toBeGreaterThan(0n);
    expect(kp.privkey).toBeLessThan(BABYJUB_ORDER);
  });

  it("pubkey is non-zero (privkey*BASE8 is valid point)", async () => {
    const kp = await deriveMemoKeyFromSignature(SIG_ALICE);
    expect(kp.pubkey.x).toBeGreaterThan(0n);
    expect(kp.pubkey.y).toBeGreaterThan(0n);
  });

  it("key separation: different context → different key from same sig", async () => {
    const kpMemo = await deriveBabyJubKeypairFromBytes(SIG_ALICE, "openjanus/memokey/v1");
    const kpView = await deriveBabyJubKeypairFromBytes(SIG_ALICE, "openjanus/viewkey/v1");
    expect(kpMemo.privkey).not.toBe(kpView.privkey);
  });

  it("MEMO_KEY_CONTEXT constant matches derivation", async () => {
    const kpDefault = await deriveMemoKeyFromSignature(SIG_ALICE);
    const kpExplicit = await deriveBabyJubKeypairFromBytes(SIG_ALICE, MEMO_KEY_CONTEXT);
    expect(kpDefault.privkey).toBe(kpExplicit.privkey);
  });

  it("rejects input shorter than 32 bytes", async () => {
    await expect(
      deriveMemoKeyFromSignature(new Uint8Array(16))
    ).rejects.toThrow(/at least 32 bytes/);
  });
});
