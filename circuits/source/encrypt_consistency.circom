pragma circom 2.0.0;

// ElGamal encrypt_consistency circuit
//
// Proves that a sender's ciphertext (C1, C2) is well-formed for a given
// recipient's public key, with value in [0, 2^48).
//
// Private inputs:
//   value      — plaintext in [0, 2^48)
//   randomness — ephemeral scalar r
//
// Public inputs:
//   recipient_pubkey[2]  — recipient's BabyJubJub public key (Bx, By)
//   C1[2]               — r * G (commitment to randomness)
//   C2[2]               — v * G + r * PK (encrypted value)
//
// Constraints:
//   1. value in [0, 2^48)  — Num2Bits(48)
//   2. C1 = r * G          — EscalarMulFix(253, BASE8) on r-bits
//   3. vG = value * G      — EscalarMulFix(253, BASE8) on value-bits
//   4. rPK = r * pubkey    — EscalarMulAny(253) on r-bits applied to pubkey
//   5. C2 = vG + rPK       — BabyAdd
//
// Constraint count estimate:
//   Num2Bits(48): ~48 constraints
//   EscalarMulFix(253): ~6 * 64 = ~384 constraints (window method)
//   EscalarMulAny(253): ~3 * 253 = ~759 constraints
//   BabyAdd: ~9 constraints
//   Total: ~2,200 constraints (fits in pot11)

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/escalarmulfix.circom";
include "circomlib/circuits/escalarmulany.circom";

template EncryptConsistency() {
    // ─── Private inputs ──────────────────────────────────────────────────────
    signal input value;       // plaintext amount in [0, 2^48)
    signal input randomness;  // ephemeral randomness r

    // ─── Public inputs ───────────────────────────────────────────────────────
    signal input recipient_pubkey[2]; // (Bx, By) — recipient's BabyJubJub pubkey
    signal input C1[2];               // claimed C1 = r * G
    signal input C2[2];               // claimed C2 = value * G + r * pubkey

    // ─── BabyJubJub Base8 generator (circomlib convention) ──────────────────
    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];

    // ─── Step 1: Range check value in [0, 2^48) ──────────────────────────────
    component valueBits = Num2Bits(48);
    valueBits.in <== value;

    // ─── Step 2: Decompose randomness to 253 bits for scalar mult ────────────
    component rBits = Num2Bits(253);
    rBits.in <== randomness;

    // ─── Step 3: Compute C1 = r * G (scalar mult on fixed base) ─────────────
    component rG = EscalarMulFix(253, BASE8);
    for (var i = 0; i < 253; i++) {
        rG.e[i] <== rBits.out[i];
    }

    // Enforce: computed C1 == public input C1
    rG.out[0] === C1[0];
    rG.out[1] === C1[1];

    // ─── Step 4: Compute value * G (scalar mult on fixed base) ───────────────
    // Pad value bits to 253 (upper bits are 0 since value < 2^48)
    component vBits = Num2Bits(253);
    // value is already range-checked to 48 bits
    // We feed value directly into Num2Bits(253): upper 205 bits will be 0
    vBits.in <== value;

    component vG = EscalarMulFix(253, BASE8);
    for (var i = 0; i < 253; i++) {
        vG.e[i] <== vBits.out[i];
    }

    // ─── Step 5: Compute r * pubkey (scalar mult on variable base) ───────────
    component rPK = EscalarMulAny(253);
    for (var i = 0; i < 253; i++) {
        rPK.e[i] <== rBits.out[i];
    }
    rPK.p[0] <== recipient_pubkey[0];
    rPK.p[1] <== recipient_pubkey[1];

    // ─── Step 6: C2 = vG + rPK ───────────────────────────────────────────────
    component addC2 = BabyAdd();
    addC2.x1 <== vG.out[0];
    addC2.y1 <== vG.out[1];
    addC2.x2 <== rPK.out[0];
    addC2.y2 <== rPK.out[1];

    // Enforce: computed C2 == public input C2
    addC2.xout === C2[0];
    addC2.yout === C2[1];
}

component main {public [recipient_pubkey, C1, C2]} = EncryptConsistency();
