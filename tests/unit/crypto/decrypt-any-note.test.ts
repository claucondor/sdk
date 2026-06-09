/**
 * tests/unit/crypto/decrypt-any-note.test.ts
 *
 * Test decryptAnyNote and decryptInboxNote for the v0.8 unified wire format.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { generateBabyJubKeypair } from "../../../src/crypto/babyjub-keypair";
import { encryptNote } from "../../../src/crypto/note-helpers";
import { decryptAnyNote, decryptInboxNote } from "../../../src/crypto/decrypt-any-note";
import type { BabyJubKeypair, InboxNote } from "../../../src/types";

let kp: BabyJubKeypair;
let otherKp: BabyJubKeypair;

beforeAll(async () => {
  [kp, otherKp] = await Promise.all([
    generateBabyJubKeypair(),
    generateBabyJubKeypair(),
  ]);
}, 30_000);

describe("decrypt-any-note", () => {
  describe("decryptAnyNote", () => {
    it("decrypts a v0.8 note (canonical wire format)", async () => {
      const original = { amount: 999n, blinding: 42n, memo: "test" };
      const enc = await encryptNote(original, kp.pubkey);

      const result = await decryptAnyNote(
        enc.ciphertext,
        enc.ephemeralPubkey,
        kp.privkey,
      );

      expect(result).not.toBeNull();
      expect(result!.amount).toBe(original.amount);
      expect(result!.blinding).toBe(original.blinding);
      expect(result!.memo).toBe(original.memo);
    });

    it("returns null for wrong key", async () => {
      const enc = await encryptNote({ amount: 1n, blinding: 1n }, kp.pubkey);
      const result = await decryptAnyNote(enc.ciphertext, enc.ephemeralPubkey, otherKp.privkey);
      expect(result).toBeNull();
    });

    it("result wireFormat is v1", async () => {
      const enc = await encryptNote({ amount: 1n, blinding: 1n }, kp.pubkey);
      const result = await decryptAnyNote(enc.ciphertext, enc.ephemeralPubkey, kp.privkey);
      expect(result!.wireFormat).toBe("v1");
    });
  });

  describe("decryptInboxNote", () => {
    it("decrypts an InboxNote", async () => {
      const original = { amount: 12345n, blinding: 67890n };
      const enc = await encryptNote(original, kp.pubkey);

      const inboxNote: InboxNote = {
        ciphertext: enc.ciphertext,
        ephPubkeyX: enc.ephemeralPubkey.x,
        ephPubkeyY: enc.ephemeralPubkey.y,
        depositor: "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3",
        blockNumber: 1000n,
      };

      const result = await decryptInboxNote(inboxNote, kp.privkey);
      expect(result).not.toBeNull();
      expect(result!.amount).toBe(original.amount);
      expect(result!.blinding).toBe(original.blinding);
    });

    it("returns null for wrong key on InboxNote", async () => {
      const enc = await encryptNote({ amount: 1n, blinding: 1n }, kp.pubkey);
      const inboxNote: InboxNote = {
        ciphertext: enc.ciphertext,
        ephPubkeyX: enc.ephemeralPubkey.x,
        ephPubkeyY: enc.ephemeralPubkey.y,
        depositor: "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3",
        blockNumber: 1n,
      };

      const result = await decryptInboxNote(inboxNote, otherKp.privkey);
      expect(result).toBeNull();
    });
  });
});
