/**
 * primitives/babyjub.ts — BabyJubJub curve operations
 *
 * Provides:
 *  - Local (off-chain) field arithmetic and point validation
 *  - ABI encoding helpers for cross-VM calls
 *  - On-chain caller via the deployed BabyJub.sol contract
 *
 * Deployed contracts:
 *  - BabyJub.sol (Flow EVM testnet): 0x2c40513b343B70f2A0B7e6Ad6F997DDa819D6f07
 *  - BabyJub.sol (lab / stateless):  0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
 */

import type { Point } from "../types/commitment";
import { CURVE_P, IDENTITY_POINT } from "../types/commitment";

// ---------------------------------------------------------------------------
// Re-export curve constants from types (single source of truth)
// ---------------------------------------------------------------------------

export { CURVE_P, IDENTITY_POINT } from "../types/commitment";

// ---------------------------------------------------------------------------
// Curve parameters
// ---------------------------------------------------------------------------

/** Twisted Edwards coefficient a */
export const CURVE_A = 168700n;

/** Twisted Edwards coefficient d */
export const CURVE_D = 168696n;

/** Standard BabyJubJub generator G */
export const GENERATOR_G: Point = {
  x: 995203441582195749578291179787384436505546430278305826713579947235728471134n,
  y: 5472060717959818805561601436314318772137091100104008585924551046643952123905n,
};

/** BASE8: 8 * G — circomlib Pedersen hash base point */
export const BASE8: Point = {
  x: 5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  y: 16950150798460657717958625567821834550301663161624707787222815936182638968203n,
};

// ---------------------------------------------------------------------------
// Deployed contract addresses
// ---------------------------------------------------------------------------

/** BabyJub.sol on Flow EVM testnet — canonical openjanus deployment */
export const BABYJUB_CONTRACT_ADDRESS = "0x2c40513b343B70f2A0B7e6Ad6F997DDa819D6f07";

/** Flow EVM testnet RPC */
export const FLOW_EVM_TESTNET_RPC = "https://testnet.evm.nodes.onflow.org";

// ---------------------------------------------------------------------------
// Local (off-chain) field arithmetic — pure functions, no network
// ---------------------------------------------------------------------------

function mulmod(a: bigint, b: bigint): bigint {
  return ((a % CURVE_P) * (b % CURVE_P)) % CURVE_P;
}

function addmod(a: bigint, b: bigint): bigint {
  return (a + b) % CURVE_P;
}

/**
 * Check if (x, y) satisfies the BabyJubJub curve equation:
 *   A * x^2 + y^2 == 1 + D * x^2 * y^2  (mod P)
 */
export function isOnCurveLocal(x: bigint, y: bigint): boolean {
  const x2 = mulmod(x, x);
  const y2 = mulmod(y, y);
  const lhs = addmod(mulmod(CURVE_A, x2), y2);
  const rhs = addmod(1n, mulmod(CURVE_D, mulmod(x2, y2)));
  return lhs === rhs;
}

/**
 * Negate a BabyJubJub point: -(x, y) = (-x mod P, y)
 */
export function negatePoint(x: bigint, y: bigint): Point {
  return {
    x: x === 0n ? 0n : CURVE_P - x,
    y,
  };
}

/**
 * Check if a point is the identity element (0, 1).
 */
export function isIdentity(x: bigint, y: bigint): boolean {
  return x === 0n && y === 1n;
}

// ---------------------------------------------------------------------------
// ABI encoding helpers for cross-VM calls (no ethers.js dependency)
// ---------------------------------------------------------------------------

/** Function selector: keccak256("babyAdd(uint256,uint256,uint256,uint256)")[:4] */
export const BABY_ADD_SELECTOR = "0xa54a0868";

/**
 * Encode calldata for babyAdd(x1, y1, x2, y2)
 */
export function encodeBabyAdd(x1: bigint, y1: bigint, x2: bigint, y2: bigint): string {
  const selector = BABY_ADD_SELECTOR.slice(2);
  const pad = (n: bigint) => n.toString(16).padStart(64, "0");
  return "0x" + selector + pad(x1) + pad(y1) + pad(x2) + pad(y2);
}

/**
 * Decode the (uint256, uint256) return from babyAdd.
 */
export function decodeBabyAddResult(data: string): Point {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length < 128) {
    throw new Error(`decodeBabyAddResult: response too short (${hex.length} chars)`);
  }
  return {
    x: BigInt("0x" + hex.slice(0, 64)),
    y: BigInt("0x" + hex.slice(64, 128)),
  };
}

// ---------------------------------------------------------------------------
// On-chain callers (ethers.js, dynamic import to keep optional)
// ---------------------------------------------------------------------------

export interface BabyJubContractOptions {
  /** RPC URL for Flow EVM (defaults to testnet) */
  rpc?: string;
  /** Contract address (defaults to testnet deployment) */
  address?: string;
}

/**
 * Call the deployed BabyJub.sol to compute babyAdd(P1, P2).
 */
export async function babyAddOnChain(
  p1: Point,
  p2: Point,
  opts: BabyJubContractOptions = {}
): Promise<Point> {
  const { ethers } = await import("ethers");
  const rpc = opts.rpc ?? FLOW_EVM_TESTNET_RPC;
  const address = opts.address ?? BABYJUB_CONTRACT_ADDRESS;

  const provider = new ethers.JsonRpcProvider(rpc);
  const abi = [
    "function babyAdd(uint256 x1, uint256 y1, uint256 x2, uint256 y2) view returns (uint256 x3, uint256 y3)",
  ];
  const contract = new ethers.Contract(address, abi, provider);
  const [x3, y3] = await contract.babyAdd(p1.x, p1.y, p2.x, p2.y);
  return { x: BigInt(x3.toString()), y: BigInt(y3.toString()) };
}

/**
 * Call the deployed BabyJub.sol to check if a point is on the curve.
 */
export async function isOnCurveOnChain(
  x: bigint,
  y: bigint,
  opts: BabyJubContractOptions = {}
): Promise<boolean> {
  const { ethers } = await import("ethers");
  const rpc = opts.rpc ?? FLOW_EVM_TESTNET_RPC;
  const address = opts.address ?? BABYJUB_CONTRACT_ADDRESS;

  const provider = new ethers.JsonRpcProvider(rpc);
  const abi = ["function isOnCurve(uint256 x, uint256 y) pure returns (bool)"];
  const contract = new ethers.Contract(address, abi, provider);
  return contract.isOnCurve(x, y);
}

/**
 * Call the deployed BabyJub.sol to negate a point.
 */
export async function negateOnChain(
  x: bigint,
  y: bigint,
  opts: BabyJubContractOptions = {}
): Promise<Point> {
  const { ethers } = await import("ethers");
  const rpc = opts.rpc ?? FLOW_EVM_TESTNET_RPC;
  const address = opts.address ?? BABYJUB_CONTRACT_ADDRESS;

  const provider = new ethers.JsonRpcProvider(rpc);
  const abi = [
    "function negate(uint256 x, uint256 y) pure returns (uint256 nx, uint256 ny)",
  ];
  const contract = new ethers.Contract(address, abi, provider);
  const [nx, ny] = await contract.negate(x, y);
  return { x: BigInt(nx.toString()), y: BigInt(ny.toString()) };
}

/**
 * Call the deployed BabyJub.sol to get the identity element.
 */
export async function identityOnChain(opts: BabyJubContractOptions = {}): Promise<Point> {
  const { ethers } = await import("ethers");
  const rpc = opts.rpc ?? FLOW_EVM_TESTNET_RPC;
  const address = opts.address ?? BABYJUB_CONTRACT_ADDRESS;

  const provider = new ethers.JsonRpcProvider(rpc);
  const abi = ["function identity() pure returns (uint256 x, uint256 y)"];
  const contract = new ethers.Contract(address, abi, provider);
  const [x, y] = await contract.identity();
  return { x: BigInt(x.toString()), y: BigInt(y.toString()) };
}

// Re-export identity for convenience — the unused import suppresses linter
const _unused = IDENTITY_POINT;
void _unused;
