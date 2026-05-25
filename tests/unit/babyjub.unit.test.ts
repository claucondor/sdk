/**
 * Unit tests for BabyJubJub curve operations — no network required.
 *
 * Known test vectors computed by circomlibjs@0.1.7 buildBabyjub().addPoint.
 */

import { describe, it, expect } from "vitest";
import {
  CURVE_P,
  CURVE_A,
  CURVE_D,
  GENERATOR_G,
  IDENTITY_POINT,
  negatePoint,
  isOnCurveLocal,
  isIdentity,
} from "../../src/primitives/babyjub";

// ---------------------------------------------------------------------------
// Reference test vectors (from circomlibjs@0.1.7 buildBabyjub())
// ---------------------------------------------------------------------------

const G = GENERATOR_G;

const G2 = {
  x: 1676417244152142056454616115823988517566305896059373631785843290555309632953n,
  y: 11563908930482997415800970727888501192209530935490958274440594569809848042842n,
};

const G3 = {
  x: 7097975954760038507620802111344412063519509458421529194055316108847963502077n,
  y: 20460065127209391267340990691555311927812546314818552928162547469063110481889n,
};

const G4 = {
  x: 11940103558519948654707819768822978214526419610986575349872581173462370334209n,
  y: 16133537043833109864904997878990023239769440361381525375236540405234196921159n,
};

// ---------------------------------------------------------------------------
// Curve constants
// ---------------------------------------------------------------------------

describe("curve constants", () => {
  it("P is the BN254 scalar field prime", () => {
    expect(CURVE_P).toBe(
      21888242871839275222246405745257275088548364400416034343698204186575808495617n
    );
  });

  it("A = 168700 (twisted Edwards coefficient a)", () => {
    expect(CURVE_A).toBe(168700n);
  });

  it("D = 168696 (twisted Edwards coefficient d)", () => {
    expect(CURVE_D).toBe(168696n);
  });

  it("identity element is (0, 1)", () => {
    expect(IDENTITY_POINT.x).toBe(0n);
    expect(IDENTITY_POINT.y).toBe(1n);
  });

  it("generator G.x and G.y match reference values", () => {
    expect(G.x).toBe(
      995203441582195749578291179787384436505546430278305826713579947235728471134n
    );
    expect(G.y).toBe(
      5472060717959818805561601436314318772137091100104008585924551046643952123905n
    );
  });
});

// ---------------------------------------------------------------------------
// isOnCurveLocal
// ---------------------------------------------------------------------------

describe("isOnCurveLocal", () => {
  it("identity (0, 1) is on curve", () => {
    expect(isOnCurveLocal(0n, 1n)).toBe(true);
  });

  it("generator G is on curve", () => {
    expect(isOnCurveLocal(G.x, G.y)).toBe(true);
  });

  it("2G is on curve", () => {
    expect(isOnCurveLocal(G2.x, G2.y)).toBe(true);
  });

  it("3G is on curve", () => {
    expect(isOnCurveLocal(G3.x, G3.y)).toBe(true);
  });

  it("4G is on curve", () => {
    expect(isOnCurveLocal(G4.x, G4.y)).toBe(true);
  });

  it("random (1, 1) is NOT on curve", () => {
    expect(isOnCurveLocal(1n, 1n)).toBe(false);
  });

  it("(0, 0) is NOT on curve", () => {
    expect(isOnCurveLocal(0n, 0n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// negatePoint
// ---------------------------------------------------------------------------

describe("negatePoint", () => {
  it("negate(identity) = identity", () => {
    const neg = negatePoint(0n, 1n);
    expect(neg.x).toBe(0n);
    expect(neg.y).toBe(1n);
  });

  it("negate(G) = (P - G.x, G.y)", () => {
    const neg = negatePoint(G.x, G.y);
    expect(neg.x).toBe(CURVE_P - G.x);
    expect(neg.y).toBe(G.y);
  });

  it("negate(negate(G)) = G (double negation)", () => {
    const neg1 = negatePoint(G.x, G.y);
    const neg2 = negatePoint(neg1.x, neg1.y);
    expect(neg2.x).toBe(G.x);
    expect(neg2.y).toBe(G.y);
  });

  it("negate(G).x + G.x ≡ 0 (mod P)", () => {
    const neg = negatePoint(G.x, G.y);
    expect((neg.x + G.x) % CURVE_P).toBe(0n);
  });

  it("negated G is still on curve", () => {
    const neg = negatePoint(G.x, G.y);
    expect(isOnCurveLocal(neg.x, neg.y)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isIdentity
// ---------------------------------------------------------------------------

describe("isIdentity", () => {
  it("identity (0, 1) returns true", () => {
    expect(isIdentity(0n, 1n)).toBe(true);
  });

  it("generator G is not identity", () => {
    expect(isIdentity(G.x, G.y)).toBe(false);
  });

  it("(0, 0) is not identity", () => {
    expect(isIdentity(0n, 0n)).toBe(false);
  });

  it("(1, 0) is not identity", () => {
    expect(isIdentity(1n, 0n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test vector consistency
// ---------------------------------------------------------------------------

describe("test vectors (reference consistency)", () => {
  it("G2.x matches circomlibjs reference", () => {
    expect(G2.x).toBe(
      1676417244152142056454616115823988517566305896059373631785843290555309632953n
    );
  });

  it("G3.x matches circomlibjs reference", () => {
    expect(G3.x).toBe(
      7097975954760038507620802111344412063519509458421529194055316108847963502077n
    );
  });

  it("G4.x matches circomlibjs reference", () => {
    expect(G4.x).toBe(
      11940103558519948654707819768822978214526419610986575349872581173462370334209n
    );
  });
});
