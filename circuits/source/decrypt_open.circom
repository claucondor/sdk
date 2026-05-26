pragma circom 2.0.0;

// ElGamal decrypt_open circuit
//
// Proves that the holder of privkey can correctly open a ciphertext to a
// specific claimed_value, without revealing privkey.
//
// Private inputs:
//   privkey — recipient's BabyJubJub private key
//
// Public inputs:
//   pubkey[2]       — recipient's registered public key
//   C1[2]           — accumulated C1 = sum_i(r_i * G)
//   C2[2]           — accumulated C2 = sum_i(v_i * G + r_i * PK)
//   claimed_value   — the claimed total (e.g. 42)
//
// Constraints:
//   1. pubkey = privkey * G  (key ownership proof)
//   2. skC1 = privkey * C1  (ElGamal shared secret)
//   3. vG_expected = claimed_value * G
//   4. vG_computed = C2 - skC1   (i.e. C2 + negate(skC1))
//   5. vG_expected == vG_computed  (correct decryption)
//   6. claimed_value in [0, 2^48)  (range check)
//
// Notes:
//   - Negation in Twisted Edwards: negate(x, y) = (-x mod p, y)
//     In the circuit, we use BabyAdd with the negated point inline.
//   - The BabyAdd constraint system handles negation implicitly
//     via the field arithmetic: -x mod p appears as P-x in witness.

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/escalarmulfix.circom";
include "circomlib/circuits/escalarmulany.circom";

template DecryptOpen() {
    // ─── Private inputs ──────────────────────────────────────────────────────
    signal input privkey;  // recipient's secret key (scalar)

    // ─── Public inputs ───────────────────────────────────────────────────────
    signal input pubkey[2];       // registered public key
    signal input C1[2];           // accumulated C1
    signal input C2[2];           // accumulated C2
    signal input claimed_value;   // the decrypted total

    // ─── BabyJubJub Base8 generator ──────────────────────────────────────────
    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];

    // BabyJubJub field prime (for negation)
    // P = 21888242871839275222246405745257275088548364400416034343698204186575808495617
    // In circom: negation is handled as P - x (field arithmetic handles this)

    // ─── Step 1: Range check claimed_value in [0, 2^48) ─────────────────────
    component valueBits = Num2Bits(48);
    valueBits.in <== claimed_value;

    // ─── Step 2: Decompose privkey to 253 bits ────────────────────────────────
    component privBits = Num2Bits(253);
    privBits.in <== privkey;

    // ─── Step 3: pubkey == privkey * G  (key ownership) ──────────────────────
    component pkComputed = EscalarMulFix(253, BASE8);
    for (var i = 0; i < 253; i++) {
        pkComputed.e[i] <== privBits.out[i];
    }

    // Enforce: computed pubkey == public input pubkey
    pkComputed.out[0] === pubkey[0];
    pkComputed.out[1] === pubkey[1];

    // ─── Step 4: skC1 = privkey * C1  (ElGamal shared secret) ───────────────
    component skC1 = EscalarMulAny(253);
    for (var i = 0; i < 253; i++) {
        skC1.e[i] <== privBits.out[i];
    }
    skC1.p[0] <== C1[0];
    skC1.p[1] <== C1[1];

    // ─── Step 5: vG_computed = C2 + negate(skC1) ────────────────────────────
    // In Twisted Edwards: negate(x, y) = (-x mod p, y)
    // In circom, field negation is 0 - x (resolved as P - x by the field).

    signal skC1_neg_x;
    skC1_neg_x <== 0 - skC1.out[0];

    component vG_computed = BabyAdd();
    vG_computed.x1 <== C2[0];
    vG_computed.y1 <== C2[1];
    vG_computed.x2 <== skC1_neg_x;
    vG_computed.y2 <== skC1.out[1];

    // ─── Step 6: vG_expected = claimed_value * G ─────────────────────────────
    component vBits = Num2Bits(253);
    vBits.in <== claimed_value;

    component vG_expected = EscalarMulFix(253, BASE8);
    for (var i = 0; i < 253; i++) {
        vG_expected.e[i] <== vBits.out[i];
    }

    // ─── Step 7: vG_expected == vG_computed  (correct decryption) ────────────
    vG_expected.out[0] === vG_computed.xout;
    vG_expected.out[1] === vG_computed.yout;
}

component main {public [pubkey, C1, C2, claimed_value]} = DecryptOpen();
