/**
 * Unit tests for deterministic BabyJubJub keypair derivation.
 *
 * Validates:
 *   1. Determinism: same input + same context → identical keypair every call.
 *   2. Context separation: same input + different context → different keypair.
 *   3. Input sensitivity: different input bytes → different keypair.
 *   4. Pubkey sanity: derived pubkey is a non-identity BabyJubJub point.
 *   5. Entropy guard: input shorter than 32 bytes throws.
 */

import { describe, it, expect } from "vitest";
import { deriveBabyJubKeypairFromBytes } from "../../src/crypto/derive-keypair";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a deterministic fake "signature" of `len` bytes filled with `fill`. */
function fakeSignature(fill: number, len = 65): Uint8Array {
  return new Uint8Array(len).fill(fill);
}

/** Hex-encode a bigint for readable assertions. */
function toHex(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deriveBabyJubKeypairFromBytes", () => {
  // ── 1. Determinism ──────────────────────────────────────────────────────

  it("produces the same keypair from the same input bytes and context", async () => {
    const input = fakeSignature(0xab);
    const context = "openjanus/memokey/v1";

    const kp1 = await deriveBabyJubKeypairFromBytes(input, context);
    const kp2 = await deriveBabyJubKeypairFromBytes(input, context);

    expect(kp1.privkey).toBe(kp2.privkey);
    expect(kp1.pubkey.x).toBe(kp2.pubkey.x);
    expect(kp1.pubkey.y).toBe(kp2.pubkey.y);
  });

  it("default context also produces a deterministic result", async () => {
    const input = fakeSignature(0x77);

    const kp1 = await deriveBabyJubKeypairFromBytes(input);
    const kp2 = await deriveBabyJubKeypairFromBytes(input);

    expect(kp1.privkey).toBe(kp2.privkey);
    expect(kp1.pubkey.x).toBe(kp2.pubkey.x);
  });

  // ── 2. Context separation ────────────────────────────────────────────────

  it("produces different keypairs for the same input with different contexts", async () => {
    const input = fakeSignature(0x55, 65);

    const memoKp = await deriveBabyJubKeypairFromBytes(
      input,
      "openjanus/memokey/v1"
    );
    const viewKp = await deriveBabyJubKeypairFromBytes(
      input,
      "openjanus/viewkey/v1"
    );

    expect(memoKp.privkey).not.toBe(viewKp.privkey);
    expect(toHex(memoKp.pubkey.x)).not.toBe(toHex(viewKp.pubkey.x));
  });

  it("produces different keypairs for an empty-string context vs default context", async () => {
    const input = fakeSignature(0x33, 65);

    const defaultKp = await deriveBabyJubKeypairFromBytes(input);
    const emptyCtxKp = await deriveBabyJubKeypairFromBytes(input, "");

    expect(defaultKp.privkey).not.toBe(emptyCtxKp.privkey);
  });

  // ── 3. Input sensitivity ─────────────────────────────────────────────────

  it("produces different keypairs for different input bytes (same context)", async () => {
    const context = "openjanus/memokey/v1";

    const kp1 = await deriveBabyJubKeypairFromBytes(fakeSignature(0x01), context);
    const kp2 = await deriveBabyJubKeypairFromBytes(fakeSignature(0x02), context);

    expect(kp1.privkey).not.toBe(kp2.privkey);
    expect(toHex(kp1.pubkey.x)).not.toBe(toHex(kp2.pubkey.x));
  });

  it("single-byte difference in input produces a completely different keypair", async () => {
    const a = new Uint8Array(65).fill(0xaa);
    const b = new Uint8Array(65).fill(0xaa);
    b[32] = 0xbb; // flip one byte in the middle

    const kpA = await deriveBabyJubKeypairFromBytes(a);
    const kpB = await deriveBabyJubKeypairFromBytes(b);

    expect(kpA.privkey).not.toBe(kpB.privkey);
  });

  // ── 4. Pubkey sanity (non-identity BabyJubJub point) ────────────────────

  it("derived pubkey is not the BabyJub identity point (0, 1)", async () => {
    const input = fakeSignature(0xde);
    const kp = await deriveBabyJubKeypairFromBytes(input);

    // BabyJub identity = (0, 1); any valid non-trivial scalar gives a different point.
    const isIdentity = kp.pubkey.x === 0n && kp.pubkey.y === 1n;
    expect(isIdentity).toBe(false);
  });

  it("derived pubkey has non-zero x and y coordinates", async () => {
    const input = fakeSignature(0xca);
    const kp = await deriveBabyJubKeypairFromBytes(input);

    expect(kp.pubkey.x).toBeGreaterThan(0n);
    expect(kp.pubkey.y).toBeGreaterThan(0n);
  });

  it("derived privkey is within the BabyJub subgroup order [1, l)", async () => {
    const BABYJUB_L =
      2736030358979909402780800718157159386076813972158567259200215660948447373041n;

    const input = fakeSignature(0xfe);
    const kp = await deriveBabyJubKeypairFromBytes(input);

    expect(kp.privkey).toBeGreaterThanOrEqual(1n);
    expect(kp.privkey).toBeLessThan(BABYJUB_L);
  });

  // ── 5. Entropy guard ─────────────────────────────────────────────────────

  it("throws if inputBytes is shorter than 32 bytes", async () => {
    const shortInput = new Uint8Array(16).fill(0x00);
    await expect(
      deriveBabyJubKeypairFromBytes(shortInput)
    ).rejects.toThrow(/at least 32 bytes/);
  });

  it("accepts exactly 32 bytes without throwing", async () => {
    const exactly32 = new Uint8Array(32).fill(0x42);
    // Should not throw.
    await expect(
      deriveBabyJubKeypairFromBytes(exactly32)
    ).resolves.toBeDefined();
  });
});
