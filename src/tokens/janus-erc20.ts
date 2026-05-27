/**
 * tokens/janus-erc20.ts — JanusERC20 concrete ERC20-wrapping confidential token (v0.4)
 *
 * JanusERC20 plugs an ERC20 underlying into the JanusToken abstract base
 * (UUPS-upgradeable, OZ Initializable). `wrap(amount, ...)` pulls the
 * underlying via `transferFrom` after the caller has approved the proxy.
 * `unwrap(claimedAmount, recipient, ...)` releases the underlying via
 * `transfer` with TWO proofs (amount-disclose + transfer).
 *
 * Privacy boundaries (mirror JanusFlow):
 *   wrap            : amount + underlying ERC20.Transfer VISIBLE   (boundary in)
 *   unwrap          : claimedAmount + underlying ERC20.Transfer VISIBLE (boundary out)
 *   shieldedTransfer: amount HIDDEN on calldata/events/storage      (full shielded)
 *
 * v0.4 production deployment (Flow EVM testnet):
 *   JanusERC20 proxy: 0xf2C04b1A32B815ac7Ffd87a4C312096592BBCa1e
 *   JanusERC20 impl : 0x7FE0B05ED77E0540519B6f10DD4b4521e867590D
 *   MockUSDC (test underlying — Flow EVM testnet lacks canonical USDC):
 *                    0x3e8973dE565743Ef9748779bE377BBE050A13C22
 *   AmountDiscloseVerifier:        0xD0ED3936530258C278f5357C1dB709ad34768352 (REUSED from v0.3)
 *   ConfidentialTransferVerifier:  0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B (REUSED from v0.3)
 *   BabyJub:                       0x27139AFda7425f51F68D32e0A38b7D43BcB0f870 (REUSED from v0.3)
 *   Owner (admin COA):             0x0000000000000000000000022f6b30af48a94787
 *
 * MAX_WRAP per call: 2^64 - 1 raw token units (= ~18.4 trillion units for a
 * 6-decimal token, or ~18.4 million USDC). Matches the circuit range proof.
 */

import type { TokenOptions } from "./types";
import {
  JanusToken,
  JANUS_BABYJUB_ADDRESS,
  AMOUNT_DISCLOSE_VERIFIER,
  CONFIDENTIAL_TRANSFER_VERIFIER,
} from "./janus-token";

// ---------------------------------------------------------------------------
// Canonical v0.4 deployment addresses (Flow EVM testnet)
// ---------------------------------------------------------------------------

/** v0.4 JanusERC20 ERC1967 proxy on Flow EVM testnet. */
export const JANUS_ERC20_EVM_ADDRESS = "0xf2C04b1A32B815ac7Ffd87a4C312096592BBCa1e";

/** v0.4 JanusERC20 implementation contract on Flow EVM testnet. */
export const JANUS_ERC20_EVM_IMPL_ADDRESS = "0x7FE0B05ED77E0540519B6f10DD4b4521e867590D";

/**
 * v0.4 MockUSDC — the ERC20 underlying pinned to the testnet JanusERC20 instance.
 * 6 decimals. Permissionlessly mintable (testnet ONLY — do NOT reuse for mainnet).
 * Flow EVM testnet does NOT have a canonical USDC; this is a placeholder so apps
 * can develop against a stable underlying address.
 */
export const JANUS_ERC20_MOCK_USDC_ADDRESS = "0x3e8973dE565743Ef9748779bE377BBE050A13C22";

/** SDK version identifier for the JanusERC20 surface. */
export const JANUS_ERC20_VERSION = "0.4.0";

/**
 * Per-call wrap cap (matches contract's MAX_WRAP — 2^64-1 raw token units).
 * For a 6-decimal token like MockUSDC, this is ~18.4M USDC.
 */
export const JANUS_ERC20_MAX_WRAP_RAW = 18_000_000_000_000_000_000n;

/** Canonical testnet TokenOptions for the v0.4 JanusERC20 deployment. */
export const JANUS_ERC20_TESTNET: TokenOptions = {
  evmAddress: JANUS_ERC20_EVM_ADDRESS,
  network: "testnet",
  babyJubAddress: JANUS_BABYJUB_ADDRESS,
  amountDiscloseVerifierAddress: AMOUNT_DISCLOSE_VERIFIER,
  confidentialTransferVerifierAddress: CONFIDENTIAL_TRANSFER_VERIFIER,
};

// ---------------------------------------------------------------------------
// ABI fragments specific to JanusERC20 (concrete wrap/unwrap signatures
// differ from JanusFlow — wrap is non-payable + takes amount explicitly)
// ---------------------------------------------------------------------------

/** ABI fragments for JanusERC20's wrap/unwrap + underlying view. */
export const JANUS_ERC20_EXTRA_ABI = [
  "function MAX_WRAP() view returns (uint256)",
  "function underlying() view returns (address)",
  "function underlyingBalance() view returns (uint256)",
  "function wrap(uint256 amount, uint256[2] txCommit, uint256[8] amountProof) external",
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof) external",
] as const;

/** Minimal ERC20 ABI — for approving the underlying ahead of wrap. */
export const ERC20_MINIMAL_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) external returns (bool)",
  // Test helper (present on MockUSDC; will revert on a real ERC20):
  "function mint(address to, uint256 amount) external",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
] as const;

// ---------------------------------------------------------------------------
// JanusERC20 class — concrete ERC20-wrapping confidential token (v0.4)
// ---------------------------------------------------------------------------

export interface JanusERC20ConstructorOptions extends TokenOptions {
  // Inherits TokenOptions; constructor defaults to JANUS_ERC20_TESTNET if
  // no overrides are supplied.
}

export class JanusERC20 extends JanusToken {
  constructor(opts: Partial<JanusERC20ConstructorOptions> = {}) {
    super({
      ...JANUS_ERC20_TESTNET,
      ...opts,
      extraAbi: JANUS_ERC20_EXTRA_ABI,
    });
  }

  /** Address of the underlying ERC20 (queried from chain). */
  async underlying(): Promise<string> {
    return await this._contract().underlying();
  }

  /** Per-call wrap cap (queried from chain). */
  async maxWrap(): Promise<bigint> {
    const v = await this._contract().MAX_WRAP();
    return BigInt(v.toString());
  }

  /** Custody-side underlying balance (= sum(wraps) − sum(unwraps), in raw units). */
  async underlyingBalance(): Promise<bigint> {
    const v = await this._contract().underlyingBalance();
    return BigInt(v.toString());
  }

  // ---------------------------------------------------------------------------
  // Write: wrap — non-payable, amount as explicit uint256
  // ---------------------------------------------------------------------------

  /**
   * Wrap `amountRaw` raw units of the underlying ERC20 into the caller's shielded slot.
   *
   * REQUIRES the caller to have previously called
   * `IERC20(underlying).approve(janusERC20Address, amountRaw)`.
   *
   * `amountRaw` is VISIBLE BY DESIGN — boundary leak (also leaked via the
   * standard ERC20.Transfer event from the underlying contract).
   *
   * Build `txCommit` + `amountProof` via `buildAmountDiscloseProof()` from
   * `@openjanus/sdk/crypto`.
   *
   * @param params.amountRaw    Underlying raw units (e.g. 1_000_000 = 1 USDC for 6 decimals).
   *                            Must equal the proof's claimed_amount and be <= MAX_WRAP.
   * @param params.txCommit     [Cx, Cy] — Pedersen commit of amountRaw.
   * @param params.amountProof  uint256[8] — pi_b Fp2-swapped Groth16 proof.
   */
  async wrap(params: {
    amountRaw: bigint;
    txCommit: readonly [bigint, bigint] | readonly bigint[];
    amountProof:
      | readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
      | readonly bigint[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<any> {
    const { amountRaw, txCommit, amountProof } = params;
    if (txCommit.length !== 2)    throw new Error(`JanusERC20.wrap: txCommit must be length 2, got ${txCommit.length}`);
    if (amountProof.length !== 8) throw new Error(`JanusERC20.wrap: amountProof must be length 8, got ${amountProof.length}`);
    if (amountRaw <= 0n)          throw new Error(`JanusERC20.wrap: amountRaw must be > 0, got ${amountRaw}`);
    if (amountRaw > JANUS_ERC20_MAX_WRAP_RAW) {
      throw new Error(`JanusERC20.wrap: amountRaw ${amountRaw} exceeds MAX_WRAP ${JANUS_ERC20_MAX_WRAP_RAW}`);
    }
    const tx = await this._contract().wrap(amountRaw, [...txCommit], [...amountProof]);
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // Write: unwrap — releases the underlying ERC20 with TWO proofs
  // ---------------------------------------------------------------------------

  /**
   * Release `claimedAmountRaw` raw units of the underlying ERC20 to `recipient`.
   * The sender's residual commitment stays hidden — only the claimed amount +
   * recipient are leaked at the boundary (plus the standard ERC20.Transfer
   * event from the underlying contract).
   *
   * Requires TWO proofs:
   *   1. amount-disclose: `txCommit` commits to `claimedAmountRaw`.
   *   2. confidential-transfer: caller's storage commitment splits into
   *      `txCommit + C_new`.
   *
   * Enforces `transferPublicInputs[0..1] == sender's stored commitment` and
   * `transferPublicInputs[2..3] == txCommit`.
   *
   * @param params.claimedAmountRaw  raw units to release (e.g. 5_000_000 = 5 USDC for 6 decimals)
   * @param params.recipient         EVM address that receives the underlying
   * @param params.txCommit          [Cx, Cy] of claimedAmountRaw
   * @param params.amountProof       uint256[8] amount-disclose proof
   * @param params.transferPublicInputs  uint256[6] — [C_old, C_tx, C_new]
   * @param params.transferProof     uint256[8] confidential-transfer proof
   */
  async unwrap(params: {
    claimedAmountRaw: bigint;
    recipient: string;
    txCommit: readonly [bigint, bigint] | readonly bigint[];
    amountProof:
      | readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
      | readonly bigint[];
    transferPublicInputs:
      | readonly [bigint, bigint, bigint, bigint, bigint, bigint]
      | readonly bigint[];
    transferProof:
      | readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
      | readonly bigint[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<any> {
    const {
      claimedAmountRaw,
      recipient,
      txCommit,
      amountProof,
      transferPublicInputs,
      transferProof,
    } = params;
    if (txCommit.length !== 2)              throw new Error("JanusERC20.unwrap: txCommit must be length 2");
    if (amountProof.length !== 8)           throw new Error("JanusERC20.unwrap: amountProof must be length 8");
    if (transferPublicInputs.length !== 6)  throw new Error("JanusERC20.unwrap: transferPublicInputs must be length 6");
    if (transferProof.length !== 8)         throw new Error("JanusERC20.unwrap: transferProof must be length 8");
    if (claimedAmountRaw <= 0n)             throw new Error(`JanusERC20.unwrap: claimedAmountRaw must be > 0, got ${claimedAmountRaw}`);

    const tx = await this._contract().unwrap(
      claimedAmountRaw,
      recipient,
      [...txCommit],
      [...amountProof],
      [...transferPublicInputs],
      [...transferProof]
    );
    return tx.wait();
  }
}
