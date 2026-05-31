/**
 * tokens/janus-token.ts — JanusToken abstract base SDK class (v0.3 Pedersen edition)
 *
 * JanusToken is the abstract on-chain confidential token primitive. v0.3 replaces
 * the v0.2 ElGamal accumulator (which leaked amounts on wrap via msg.value events
 * AND on shielded transfers via cleartext `transferUnits`) with a fully shielded
 * Pedersen commitment scheme.
 *
 * Per-account state:
 *   commitments[user] : Pedersen(value, blinding) point on BabyJubJub.
 *   The total-supply commitment is the homomorphic sum across all users.
 *
 * Privacy boundaries (v0.3 — empirically validated; see lab v03-smoke.mjs):
 *   wrap / unwrap     LEAK the cleartext amount (boundary with the underlying asset)
 *   shieldedTransfer  HIDES amount on calldata, events, AND storage updates
 *   storage           HIDE per-account commitments; LEAK aggregate totalLocked
 *   commitment opacity HIDE behind 128-bit Pedersen blinding (no brute force)
 *
 * This module is GENERIC — it has no app-specific concepts (no "tip", no "payroll").
 * Apps compose this primitive into their own UX.
 *
 * v0.5 production deployment (Flow EVM testnet):
 *   JanusFlow proxy:               0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078  (UNCHANGED)
 *   JanusFlow impl:                0xa2607E9EAb1718a2fAf5a1328A7d3a9Aa854efff  (v0.5, 2^128 MAX_WRAP + setVerifiers)
 *   AmountDiscloseVerifier:        0x9c83b2b1EFFD3bd375b9Bee93Cb618005D6A2Dc4  (v0.5.1 / pot18 ceremony)
 *   ConfidentialTransferVerifier:  0x48f791D2a4992F448Cc36F12e5500b6553e969b3  (v0.5.1 / pot18 ceremony)
 *   BabyJub.sol (re-used):         0x27139AFda7425f51F68D32e0A38b7D43BcB0f870  (UNCHANGED)
 *   Owner (admin COA):             0x0000000000000000000000022f6b30af48a94787  (UNCHANGED)
 *
 * v0.3 deployment (SUPERSEDED by v0.5):
 *   JanusFlow proxy:               0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078
 *   AmountDiscloseVerifier:        0xD0ED3936530258C278f5357C1dB709ad34768352
 *   ConfidentialTransferVerifier:  0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B
 *
 * v0.2 addresses (DEPRECATED — DO NOT USE — leaked amount privacy):
 *   JanusToken EVM (ElGamal):      0x025efe7e89acdb8F315C804BE7245F348AA9c538
 *
 * See MIGRATION-v0.3.md for migration steps from v0.2.
 */

import type { Point } from "../types/commitment";
import type { TokenOptions } from "./types";
import { NETWORK_CONFIG } from "../network/flow-client";

// ---------------------------------------------------------------------------
// Canonical v0.5 deployment addresses (Flow EVM testnet)
// ---------------------------------------------------------------------------

/** BabyJub.sol address (re-used — unchanged since v0.2). */
export const JANUS_BABYJUB_ADDRESS = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";

/**
 * AmountDiscloseVerifier — Groth16 verifier that binds a Pedersen commit to
 * a public scalar amount. Used for wrap/unwrap boundary proofs.
 * v0.5.1: ceremony-backed (Hermez pot18 + Flow VRF beacon block 324226714).
 *         Supports amounts up to 2^128 wei (same as v0.5).
 */
export const AMOUNT_DISCLOSE_VERIFIER = "0x9c83b2b1EFFD3bd375b9Bee93Cb618005D6A2Dc4";

/**
 * ConfidentialTransferVerifier — Groth16 verifier for the v0.5 transfer circuit
 * proving C_new = C_old - C_tx + range-checks. Used for shieldedTransfer.
 * v0.5.1: pot18 ceremony (Hermez pot18 + Flow VRF beacon block 324226714).
 *         Supports balances up to 2^128 (same as v0.5).
 */
export const CONFIDENTIAL_TRANSFER_VERIFIER = "0x48f791D2a4992F448Cc36F12e5500b6553e969b3";

// ---------------------------------------------------------------------------
// Superseded addresses (for archival / log archaeology)
// ---------------------------------------------------------------------------
export const JANUS_V05_SUPERSEDED_VERIFIERS = {
  AmountDiscloseVerifier:       "0xee5Dc464e7e9782c7b04FC0bEAd0EBC2F366945b",  // v0.5 / pot14
  ConfidentialTransferVerifier: "0x93cb6f84B30455CCF2154C671F96201333756D9e",  // v0.5 / pot14
} as const;

export const JANUS_V03_DEPRECATED_VERIFIERS = {
  AmountDiscloseVerifier:       "0xD0ED3936530258C278f5357C1dB709ad34768352",
  ConfidentialTransferVerifier: "0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B",
} as const;

/** Admin COA owner of the JanusFlow proxy on Flow EVM testnet. */
export const JANUS_TOKEN_OWNER_EVM = "0x0000000000000000000000022f6b30af48a94787";

/**
 * @deprecated v0.2 ElGamal verifier — REMOVED in v0.3. Kept here for log-archeology only.
 */
export const JANUS_TOKEN_DEPRECATED_ADDRESSES = {
  v02ElGamalProxy: "0x025efe7e89acdb8F315C804BE7245F348AA9c538",
  v02EncryptVerifier: "0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e",
  v02DecryptVerifier: "0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc",
  v01PreScaleFix: "0xb12E600fFcde967210cFD81CF9f32bBB6e68a499",
  v01PreCeremony: "0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D",
} as const;

// ---------------------------------------------------------------------------
// Minimal ABI for the v0.3 JanusToken abstract base
//
// Method names match the on-chain Solidity contract (JanusToken.sol + JanusFlow.sol):
//   - balanceOfCommitment(user) view returns (Point)
//   - balanceOfCommitmentXY(user) view returns (uint256, uint256)
//   - commitments(user) view returns (uint256 x, uint256 y)
//   - totalSupplyCommitment() view returns (uint256 x, uint256 y)
//   - totalLocked() view returns (uint256)
//   - shieldedTransfer(to, publicInputs[6], proof[8])
//   - babyJub() view returns (address)
//   - transferVerifier() view returns (address)
//   - amountDiscloseVerifier() view returns (address)
//
// Subclasses for concrete tokens (JanusFlow) add wrap/unwrap with their own
// custody signature. The ABI for wrap/unwrap lives in janus-flow.ts.
// ---------------------------------------------------------------------------

/** Generic v0.3 JanusToken ABI subset — slot reads, transfer, primitive views. */
export const JANUS_TOKEN_BASE_ABI = [
  "function balanceOfCommitment(address user) view returns (tuple(uint256 x, uint256 y))",
  "function balanceOfCommitmentXY(address user) view returns (uint256 x, uint256 y)",
  "function commitments(address user) view returns (uint256 x, uint256 y)",
  "function totalSupplyCommitment() view returns (uint256 x, uint256 y)",
  "function totalLocked() view returns (uint256)",
  "function babyJub() view returns (address)",
  "function transferVerifier() view returns (address)",
  "function amountDiscloseVerifier() view returns (address)",
  "function owner() view returns (address)",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof) external",
  // Events
  "event Wrapped(address indexed user, uint256 amount)",
  "event Unwrapped(address indexed user, address indexed recipient, uint256 amount)",
  "event ConfidentialTransfer(address indexed from, address indexed to)",
] as const;

// ---------------------------------------------------------------------------
// JanusToken class — abstract read-only EVM connector
//
// Subclasses (e.g. JanusFlow) add wrap/unwrap with the custody semantics for
// the underlying asset. JanusToken itself exposes only the shielded primitives
// that every concrete openjanus token shares.
// ---------------------------------------------------------------------------

export interface JanusTokenOptions extends TokenOptions {
  /** Pre-merged subclass ABI fragments to extend the base ABI. */
  extraAbi?: readonly string[];
}

export class JanusToken {
  protected readonly opts: TokenOptions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected contract: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected signer: any = null;
  protected readonly _abi: readonly string[];

  constructor(opts: JanusTokenOptions) {
    this.opts = opts;
    this._abi = opts.extraAbi
      ? [...JANUS_TOKEN_BASE_ABI, ...opts.extraAbi]
      : [...JANUS_TOKEN_BASE_ABI];
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  /** Connect with a read-only provider. Enables all view functions. */
  async connect(): Promise<this> {
    const { ethers } = await import("ethers");
    const rpc = NETWORK_CONFIG[this.opts.network].evmRpc;
    const provider = new ethers.JsonRpcProvider(rpc);
    this.contract = new ethers.Contract(this.opts.evmAddress, this._abi, provider);
    return this;
  }

  /** Connect with a signing wallet. Enables state-changing functions. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async connectWithSigner(signer: any): Promise<this> {
    const { ethers } = await import("ethers");
    this.signer = signer;
    this.contract = new ethers.Contract(this.opts.evmAddress, this._abi, signer);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  /** Return the deployed EVM address (the JanusFlow / JanusToken proxy). */
  get address(): string {
    return this.opts.evmAddress;
  }

  // ---------------------------------------------------------------------------
  // View: shielded commitments
  // ---------------------------------------------------------------------------

  /**
   * Read the Pedersen commitment of an account's hidden balance.
   * Returns identity (0, 1) for accounts that have never been written to.
   */
  async balanceOfCommitment(account: string): Promise<Point> {
    const c = await this._contract().balanceOfCommitment(account);
    return { x: BigInt(c.x.toString()), y: BigInt(c.y.toString()) };
  }

  /**
   * Read the homomorphic sum of all balance commitments (total supply).
   * Always equals sum(commitments[a]) over all accounts.
   */
  async totalSupplyCommitment(): Promise<Point> {
    const [x, y] = await this._contract().totalSupplyCommitment();
    return { x: BigInt(x.toString()), y: BigInt(y.toString()) };
  }

  /**
   * Read the cleartext `totalLocked` custody pool (VISIBLE BY DESIGN —
   * boundary accounting). An external observer can audit the size of the
   * shielded pool at any time.
   */
  async totalLocked(): Promise<bigint> {
    const v = await this._contract().totalLocked();
    return BigInt(v.toString());
  }

  // ---------------------------------------------------------------------------
  // Write: shieldedTransfer — amount HIDDEN on all channels
  // ---------------------------------------------------------------------------

  /**
   * Send a HIDDEN amount from msg.sender to `to`. Caller must supply the
   * confidential-transfer Groth16 proof + 6 public inputs:
   *   [0..1] C_old — sender's current commitment (must match storage)
   *   [2..3] C_tx  — Pedersen(transferAmount, transferBlinding)
   *   [4..5] C_new — sender's residual commitment after the transfer
   *
   * Build the proof with `buildShieldedTransferProof()` from `@openjanus/sdk/crypto`.
   *
   * @param params.to            Recipient EVM address (must not be msg.sender or zero)
   * @param params.publicInputs  uint256[6] — see layout above
   * @param params.proof         uint256[8] — pi_b Fp2-swapped Groth16 proof
   */
  async shieldedTransfer(params: {
    to: string;
    publicInputs:
      | readonly [bigint, bigint, bigint, bigint, bigint, bigint]
      | readonly bigint[];
    proof:
      | readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
      | readonly bigint[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<any> {
    const { to, publicInputs, proof } = params;
    if (publicInputs.length !== 6) {
      throw new Error(
        `JanusToken.shieldedTransfer: publicInputs must have 6 elements, got ${publicInputs.length}`
      );
    }
    if (proof.length !== 8) {
      throw new Error(
        `JanusToken.shieldedTransfer: proof must have 8 elements, got ${proof.length}`
      );
    }
    const tx = await this._contract().shieldedTransfer(
      to,
      [...publicInputs],
      [...proof]
    );
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected _contract(): any {
    if (!this.contract) {
      throw new Error(
        "JanusToken: not connected. Call await token.connect() or await token.connectWithSigner(signer) first."
      );
    }
    return this.contract;
  }
}
