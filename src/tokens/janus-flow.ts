/**
 * tokens/janus-flow.ts — JanusFlow concrete native-FLOW token (v0.3)
 *
 * JanusFlow plugs native FLOW custody into the JanusToken abstract base.
 * `wrap()` is payable and binds `msg.value` to a Pedersen commitment via
 * the amount-disclose proof. `unwrap()` releases the claimed amount and
 * proves the shielded debit via TWO proofs (amount-disclose + transfer).
 *
 * Privacy boundaries (validated empirically — see lab v03-smoke.mjs):
 *   wrap            : msg.value VISIBLE | commitment opaque       (boundary in)
 *   unwrap          : claimedAmount + recipient VISIBLE           (boundary out)
 *   shieldedTransfer: amount HIDDEN on calldata/events/storage    (full shielded)
 *
 * v0.5 production deployment (Flow EVM testnet):
 *   JanusFlow proxy:               0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078  (UNCHANGED)
 *   JanusFlow impl:                0xa2607E9EAb1718a2fAf5a1328A7d3a9Aa854efff  (v0.5)
 *   AmountDiscloseVerifier:        0xee5Dc464e7e9782c7b04FC0bEAd0EBC2F366945b  (v0.5 ceremony)
 *   ConfidentialTransferVerifier:  0x93cb6f84B30455CCF2154C671F96201333756D9e  (v0.5 ceremony)
 *   BabyJub (re-used):             0x27139AFda7425f51F68D32e0A38b7D43BcB0f870  (UNCHANGED)
 *   Owner (admin COA):             0x0000000000000000000000022f6b30af48a94787  (UNCHANGED)
 *
 * Cadence router (v0.3, cross-VM wrapper — UNCHANGED, still calls proxy at same address):
 *   Address:        0x5dcbeb41055ec57e (router) — calls the EVM proxy via COA
 *   Contract:       JanusFlow
 *
 * MAX_WRAP per call: 2^128-1 attoFLOW (effectively unbounded for all realistic FLOW amounts).
 */

import type { Point } from "../types/commitment";
import type { TokenOptions } from "./types";
import type { FlowNetwork } from "../network/flow-client";
import {
  JanusToken,
  JANUS_BABYJUB_ADDRESS,
  AMOUNT_DISCLOSE_VERIFIER,
  CONFIDENTIAL_TRANSFER_VERIFIER,
} from "./janus-token";

// ---------------------------------------------------------------------------
// Canonical v0.3 deployment addresses
// ---------------------------------------------------------------------------

/** v0.3 JanusFlow ERC1967 proxy on Flow EVM testnet. */
export const JANUS_FLOW_EVM_ADDRESS = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";

/** v0.5.3 JanusFlow implementation contract on Flow EVM testnet. */
export const JANUS_FLOW_EVM_IMPL_ADDRESS = "0xd6584cb2788D2eA5c3AB61fb72aa9fEaC27ae79D";

/** v0.3 Cadence router address (cross-VM wrapper around the EVM proxy — unchanged). */
export const JANUS_FLOW_CADENCE_ADDRESS = "0x5dcbeb41055ec57e";

/** Cadence contract name at the router address. */
export const JANUS_FLOW_CONTRACT_NAME = "JanusFlow";

/** SDK version identifier. Tracks the SDK version (on-chain Cadence router still reports v0.3.0). */
export const JANUS_FLOW_VERSION = "0.5.3";

/**
 * Per-call wrap cap. v0.5: 2^128-1 attoFLOW (effectively unbounded — matches the
 * 128-bit Num2Bits range proof in confidential_transfer.circom v0.5).
 * The on-chain contract's MAX_WRAP constant reads as type(uint128).max.
 */
export const JANUS_FLOW_MAX_WRAP_ATTOFLOW = (1n << 128n) - 1n;

/** Canonical testnet TokenOptions for the v0.3 JanusFlow deployment. */
export const JANUS_FLOW_TESTNET: TokenOptions = {
  evmAddress: JANUS_FLOW_EVM_ADDRESS,
  network: "testnet",
  babyJubAddress: JANUS_BABYJUB_ADDRESS,
  amountDiscloseVerifierAddress: AMOUNT_DISCLOSE_VERIFIER,
  confidentialTransferVerifierAddress: CONFIDENTIAL_TRANSFER_VERIFIER,
};

/**
 * @deprecated v0.2 ElGamal JanusToken proxy — REMOVED in v0.3. Kept here for
 * log-archeology only. v0.2 leaked the amount on every wrap and the per-sender
 * cleartext `transferUnits` on every confidential transfer; see audits-kb
 * vulnerability 014 + the v0.3 privacy audit findings for the rationale.
 */
export const JANUS_FLOW_EVM_ADDRESS_DEPRECATED_V02 =
  "0x025efe7e89acdb8F315C804BE7245F348AA9c538";

/**
 * @deprecated v0.2 Cadence router (now points at the v0.2 EVM JanusToken).
 * The v0.3 router upgrade landed at the SAME Cadence address, but apps that
 * pinned to the OLD evm target should migrate to JANUS_FLOW_EVM_ADDRESS.
 */
export const JANUS_FLOW_CADENCE_ADDRESS_PREVIOUS = "0xbef3c77681c15397";

/**
 * @deprecated Legacy v1 Pedersen zombie at this address — cannot be removed
 * (Flow protocol restriction). DO NOT USE.
 */
export const JANUS_FLOW_CADENCE_ADDRESS_LEGACY = "0x28fef3d1d6a12800";

// ---------------------------------------------------------------------------
// ABI fragments specific to the JanusFlow concrete subclass (wrap/unwrap)
// ---------------------------------------------------------------------------

/**
 * ABI fragments for JanusFlow v0.5.2 concrete signatures.
 *
 * v0.5.2 breaking changes (old signatures removed):
 *   - wrap: adds encryptedSnapshot, ephPubkeyX, ephPubkeyY params
 *   - unwrap: adds encryptedSnapshot, ephPubkeyX, ephPubkeyY params
 *   - shieldedTransfer: adds encryptedSnapshot, ephPubkeyX, ephPubkeyY params
 *   - publishMemoKey: new function to register BabyJub pubkey on EVM
 *   - memoKeyPubX/Y: new view mappings
 */
export const JANUS_FLOW_EXTRA_ABI = [
  "function MAX_WRAP() view returns (uint256)",
  "function wrap(uint256[2] txCommit, uint256[8] amountProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external payable",
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  "function publishMemoKey(uint256 pubkeyX, uint256 pubkeyY) external",
  "function memoKeyPubX(address) view returns (uint256)",
  "function memoKeyPubY(address) view returns (uint256)",
] as const;

// ---------------------------------------------------------------------------
// Calldata builders — pure functions, no signer / no provider
//
// These produce the hex calldata strings that the Cadence router passes
// through to the EVM JanusFlow proxy via `coa.call(...)`. Callers are
// responsible for stripping the leading "0x" if their Cadence side does
// `String.decodeHex()` (the SDK's bundled TX_* templates do).
// ---------------------------------------------------------------------------

/**
 * Build calldata for `JanusFlow.wrap(txCommit, amountProof, encryptedSnapshot, ephPubkeyX, ephPubkeyY)`.
 * Returns hex string WITHOUT leading 0x.
 *
 * v0.5.2: encryptedSnapshot + ephPubkeyX/Y are required. Pass `"0x"` and `0n`/`0n`
 * if you don't have a snapshot (not recommended — defeats recovery).
 */
export async function buildWrapCalldata(
  txCommit: readonly [bigint, bigint] | readonly bigint[],
  amountProof: readonly bigint[],
  encryptedSnapshot: Uint8Array | string = "0x",
  ephPubkeyX: bigint = 0n,
  ephPubkeyY: bigint = 0n
): Promise<string> {
  const { Interface, hexlify } = await import("ethers");
  const iface = new Interface(JANUS_FLOW_EXTRA_ABI as unknown as string[]);
  const snapshotHex =
    typeof encryptedSnapshot === "string"
      ? encryptedSnapshot
      : hexlify(encryptedSnapshot);
  return iface
    .encodeFunctionData("wrap", [
      [...txCommit],
      [...amountProof],
      snapshotHex,
      ephPubkeyX,
      ephPubkeyY,
    ])
    .slice(2);
}

/**
 * Build calldata for `JanusFlow.shieldedTransfer(address, uint256[6], uint256[8], bytes, uint256, uint256)`.
 * Returns hex string WITHOUT leading 0x.
 *
 * v0.5.2: encryptedSnapshot is the SENDER'S residual snapshot after transfer.
 * Pass `"0x"` and `0n`/`0n` if not using snapshots (not recommended).
 *
 * NOTE: shieldedTransfer signature updated to include snapshot params in v0.5.2.
 */
const SHIELDED_TRANSFER_ABI = [
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
] as const;

export async function buildShieldedTransferCalldata(
  to: string,
  publicInputs: readonly bigint[],
  proof: readonly bigint[],
  encryptedSnapshot: Uint8Array | string = "0x",
  ephPubkeyX: bigint = 0n,
  ephPubkeyY: bigint = 0n
): Promise<string> {
  const { Interface, hexlify } = await import("ethers");
  const iface = new Interface(SHIELDED_TRANSFER_ABI as unknown as string[]);
  const snapshotHex =
    typeof encryptedSnapshot === "string"
      ? encryptedSnapshot
      : hexlify(encryptedSnapshot);
  return iface
    .encodeFunctionData("shieldedTransfer", [
      to,
      [...publicInputs],
      [...proof],
      snapshotHex,
      ephPubkeyX,
      ephPubkeyY,
    ])
    .slice(2);
}

/**
 * Build calldata for `JanusFlow.unwrap(claimedAmount, recipient, txCommit,
 * amountProof, transferPublicInputs, transferProof, encryptedSnapshot, ephPubkeyX, ephPubkeyY)`.
 * Returns hex string WITHOUT leading 0x.
 *
 * v0.5.2: encryptedSnapshot is the residual shielded balance AFTER the unwrap.
 * Pass `"0x"` and `0n`/`0n` if not using snapshots (not recommended).
 */
export async function buildUnwrapCalldata(
  claimedAmountWei: bigint,
  recipientEvmHex: string,
  txCommit: readonly [bigint, bigint] | readonly bigint[],
  amountProof: readonly bigint[],
  transferPublicInputs: readonly bigint[],
  transferProof: readonly bigint[],
  encryptedSnapshot: Uint8Array | string = "0x",
  ephPubkeyX: bigint = 0n,
  ephPubkeyY: bigint = 0n
): Promise<string> {
  const { Interface, hexlify } = await import("ethers");
  const iface = new Interface(JANUS_FLOW_EXTRA_ABI as unknown as string[]);
  const snapshotHex =
    typeof encryptedSnapshot === "string"
      ? encryptedSnapshot
      : hexlify(encryptedSnapshot);
  return iface
    .encodeFunctionData("unwrap", [
      claimedAmountWei,
      recipientEvmHex,
      [...txCommit],
      [...amountProof],
      [...transferPublicInputs],
      [...transferProof],
      snapshotHex,
      ephPubkeyX,
      ephPubkeyY,
    ])
    .slice(2);
}

// ---------------------------------------------------------------------------
// Static EVM reads — provider-only, no contract instance needed
// ---------------------------------------------------------------------------

/** Browser-safe `balanceOfCommitmentXY` reader. */
export async function readCommitment(
  provider: import("ethers").Provider,
  coaEvmHex: string,
  contractAddress: string = JANUS_FLOW_EVM_ADDRESS
): Promise<Point> {
  const { Interface } = await import("ethers");
  const iface = new Interface([
    "function balanceOfCommitmentXY(address) view returns (uint256, uint256)",
  ]);
  const data = iface.encodeFunctionData("balanceOfCommitmentXY", [coaEvmHex]);
  const result = await provider.call({ to: contractAddress, data });
  const [x, y] = iface.decodeFunctionResult(
    "balanceOfCommitmentXY",
    result
  );
  return { x: BigInt(x), y: BigInt(y) };
}

/** Browser-safe `totalLocked` reader. */
export async function readTotalLocked(
  provider: import("ethers").Provider,
  contractAddress: string = JANUS_FLOW_EVM_ADDRESS
): Promise<bigint> {
  const { Interface } = await import("ethers");
  const iface = new Interface([
    "function totalLocked() view returns (uint256)",
  ]);
  const data = iface.encodeFunctionData("totalLocked", []);
  const result = await provider.call({ to: contractAddress, data });
  const [v] = iface.decodeFunctionResult("totalLocked", result);
  return BigInt(v);
}

// ---------------------------------------------------------------------------
// Wrap source resolution — vault vs COA decision
// ---------------------------------------------------------------------------

/** Where the FLOW being wrapped comes from. */
export type WrapSource = "vault" | "coa";

export interface ResolveWrapSourceInput {
  /** Amount to wrap, in wei. */
  amountWei: bigint;
  /** Signer's Cadence FlowToken.Vault balance in wei. */
  vaultWei: bigint;
  /** Signer's COA EVM-side balance in wei. */
  coaWei: bigint;
  /**
   * Preferred source. "auto" picks vault if it can cover the amount, otherwise
   * COA. "vault" and "coa" pin the source explicitly (and error if the chosen
   * source can't cover the amount).
   *
   * @default "auto"
   */
  preference?: "auto" | WrapSource;
}

export interface ResolveWrapSourceError {
  ok: false;
  error: string;
}

export interface ResolveWrapSourceOk {
  ok: true;
  source: WrapSource;
}

export type ResolveWrapSourceResult = ResolveWrapSourceOk | ResolveWrapSourceError;

/**
 * Pure decision function — picks the right wrap source given the user's
 * vault + COA balances. Apps that call this in form-state computations can
 * rely on it being side-effect free.
 */
export function resolveWrapSource(input: ResolveWrapSourceInput): ResolveWrapSourceResult {
  const { amountWei, vaultWei, coaWei, preference = "auto" } = input;
  if (amountWei <= 0n) {
    return { ok: false, error: "amountWei must be > 0" };
  }
  if (preference === "vault") {
    if (vaultWei < amountWei) {
      return {
        ok: false,
        error: `vault balance ${vaultWei} insufficient for ${amountWei}`,
      };
    }
    return { ok: true, source: "vault" };
  }
  if (preference === "coa") {
    if (coaWei < amountWei) {
      return {
        ok: false,
        error: `COA balance ${coaWei} insufficient for ${amountWei}`,
      };
    }
    return { ok: true, source: "coa" };
  }
  // auto — prefer vault.
  if (vaultWei >= amountWei) return { ok: true, source: "vault" };
  if (coaWei >= amountWei) return { ok: true, source: "coa" };
  return {
    ok: false,
    error: `neither vault (${vaultWei}) nor COA (${coaWei}) can cover ${amountWei}`,
  };
}

// ---------------------------------------------------------------------------
// JanusFlow class — concrete native-FLOW confidential token (v0.3)
// ---------------------------------------------------------------------------

export interface JanusFlowConstructorOptions extends TokenOptions {
  // Inherits TokenOptions; the constructor takes the canonical testnet defaults
  // unless overridden.
}

export class JanusFlow extends JanusToken {
  constructor(opts: Partial<JanusFlowConstructorOptions> = {}) {
    super({
      ...JANUS_FLOW_TESTNET,
      ...opts,
      extraAbi: JANUS_FLOW_EXTRA_ABI,
    });
  }

  /** Per-call wrap cap (queried from chain). */
  async maxWrap(): Promise<bigint> {
    const v = await this._contract().MAX_WRAP();
    return BigInt(v.toString());
  }

  // ---------------------------------------------------------------------------
  // Write: wrap — payable; binds msg.value to a Pedersen commitment
  // ---------------------------------------------------------------------------

  /**
   * Wrap `amountWei` of native FLOW into the caller's shielded slot.
   *
   * v0.5.2: Pass `encryptedSnapshot`, `ephPubkeyX`, `ephPubkeyY` so JanusFlow
   * emits a WrapWithSnapshot event. Omitting them defaults to empty bytes / 0n
   * (valid but defeats recovery — the on-chain snapshot channel is bypassed).
   *
   * Build `txCommit` + `amountProof` via `buildAmountDiscloseProof()`.
   * Build `encryptedSnapshot` via `recovery.encryptSnapshotToSelf()`.
   *
   * msg.value is VISIBLE BY DESIGN — this is the wrap boundary.
   *
   * @param params.amountWei          msg.value (attoFLOW). Must equal proof's
   *                                  claimed_amount and be <= MAX_WRAP.
   * @param params.txCommit           [Cx, Cy] — Pedersen commit of amountWei
   * @param params.amountProof        uint256[8] — pi_b Fp2-swapped Groth16 proof
   * @param params.encryptedSnapshot  Encrypted (balance, blinding) blob (optional)
   * @param params.ephPubkeyX         Ephemeral pubkey X for snapshot decryption
   * @param params.ephPubkeyY         Ephemeral pubkey Y for snapshot decryption
   */
  async wrap(params: {
    amountWei: bigint;
    txCommit: readonly [bigint, bigint] | readonly bigint[];
    amountProof:
      | readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
      | readonly bigint[];
    encryptedSnapshot?: Uint8Array | string;
    ephPubkeyX?: bigint;
    ephPubkeyY?: bigint;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<any> {
    const {
      amountWei,
      txCommit,
      amountProof,
      encryptedSnapshot = "0x",
      ephPubkeyX = 0n,
      ephPubkeyY = 0n,
    } = params;
    if (txCommit.length !== 2) {
      throw new Error(
        `JanusFlow.wrap: txCommit must have 2 elements, got ${txCommit.length}`
      );
    }
    if (amountProof.length !== 8) {
      throw new Error(
        `JanusFlow.wrap: amountProof must have 8 elements, got ${amountProof.length}`
      );
    }
    if (amountWei <= 0n) {
      throw new Error(`JanusFlow.wrap: amountWei must be > 0, got ${amountWei}`);
    }
    if (amountWei > JANUS_FLOW_MAX_WRAP_ATTOFLOW) {
      throw new Error(
        `JanusFlow.wrap: amountWei ${amountWei} exceeds MAX_WRAP ${JANUS_FLOW_MAX_WRAP_ATTOFLOW}`
      );
    }
    const { hexlify } = await import("ethers");
    const snapshotHex =
      typeof encryptedSnapshot === "string"
        ? encryptedSnapshot
        : hexlify(encryptedSnapshot);
    const tx = await this._contract().wrap(
      [...txCommit],
      [...amountProof],
      snapshotHex,
      ephPubkeyX,
      ephPubkeyY,
      { value: amountWei }
    );
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // Write: publishMemoKey — register BabyJub pubkey for snapshot decryption
  // ---------------------------------------------------------------------------

  /**
   * Publish the caller's BabyJub pubkey in the JanusFlow EVM mapping.
   *
   * Any user who wants to receive recoverable snapshots or receive shielded
   * notes from senders who look up their pubkey must call this once.
   *
   * Emits `MemoKeyPublished(user, pubkeyX, pubkeyY)` on JanusFlow.sol.
   *
   * For the full atomic Cadence+EVM setup (recommended), use the
   * `setup_memo_key.cdc` transaction via `TX_SETUP_MEMO_KEY`.
   */
  async publishMemoKey(pubkey: {
    x: bigint;
    y: bigint;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<any> {
    const tx = await this._contract().publishMemoKey(pubkey.x, pubkey.y);
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // Read: getMemoKeyPubkey — look up a user's registered BabyJub pubkey
  // ---------------------------------------------------------------------------

  /**
   * Read a user's registered BabyJub pubkey from the JanusFlow EVM mapping.
   * Returns `null` if no pubkey has been registered (both x and y are 0).
   *
   * Senders use this to encrypt ShieldedNotes to recipients who have
   * registered their pubkey. Recovery also uses this to identify which
   * snapshot events to attempt decryption on.
   */
  async getMemoKeyPubkey(
    userEvmAddr: string
  ): Promise<{ x: bigint; y: bigint } | null> {
    const [x, y] = await Promise.all([
      this._contract().memoKeyPubX(userEvmAddr),
      this._contract().memoKeyPubY(userEvmAddr),
    ]);
    const xBig = BigInt(x);
    const yBig = BigInt(y);
    if (xBig === 0n && yBig === 0n) return null;
    return { x: xBig, y: yBig };
  }

  // ---------------------------------------------------------------------------
  // Write: unwrap — releases native FLOW with ZK proofs
  // ---------------------------------------------------------------------------

  /**
   * Release `claimedAmountWei` of native FLOW to `recipient`. The sender's
   * residual commitment stays hidden — only the claimed amount + recipient
   * are leaked at the boundary.
   *
   * v0.5.2: Pass `encryptedSnapshot`, `ephPubkeyX`, `ephPubkeyY` to emit an
   * UnwrapWithSnapshot event capturing the residual shielded balance after the
   * unwrap. Defaults to empty bytes / 0n (no snapshot emitted).
   *
   * Requires TWO proofs:
   *   1. amount-disclose: `txCommit` commits to `claimedAmountWei`.
   *   2. confidential-transfer: caller's storage commitment can be split into
   *      `txCommit + C_new`.
   *
   * @param params.claimedAmountWei  attoFLOW being released
   * @param params.recipient         EVM address that receives the FLOW
   * @param params.txCommit          [Cx, Cy] of claimedAmountWei
   * @param params.amountProof       uint256[8] amount-disclose proof
   * @param params.transferPublicInputs  uint256[6] — [C_old, C_tx, C_new]
   * @param params.transferProof     uint256[8] confidential-transfer proof
   * @param params.encryptedSnapshot  Residual snapshot after unwrap (optional)
   * @param params.ephPubkeyX/Y      Ephemeral pubkey for snapshot decryption
   */
  async unwrap(params: {
    claimedAmountWei: bigint;
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
    encryptedSnapshot?: Uint8Array | string;
    ephPubkeyX?: bigint;
    ephPubkeyY?: bigint;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<any> {
    const {
      claimedAmountWei,
      recipient,
      txCommit,
      amountProof,
      transferPublicInputs,
      transferProof,
      encryptedSnapshot = "0x",
      ephPubkeyX = 0n,
      ephPubkeyY = 0n,
    } = params;
    if (txCommit.length !== 2) throw new Error("JanusFlow.unwrap: txCommit must be length 2");
    if (amountProof.length !== 8) throw new Error("JanusFlow.unwrap: amountProof must be length 8");
    if (transferPublicInputs.length !== 6)
      throw new Error("JanusFlow.unwrap: transferPublicInputs must be length 6");
    if (transferProof.length !== 8)
      throw new Error("JanusFlow.unwrap: transferProof must be length 8");
    if (claimedAmountWei <= 0n)
      throw new Error(`JanusFlow.unwrap: claimedAmountWei must be > 0, got ${claimedAmountWei}`);

    const { hexlify } = await import("ethers");
    const snapshotHex =
      typeof encryptedSnapshot === "string"
        ? encryptedSnapshot
        : hexlify(encryptedSnapshot);

    const tx = await this._contract().unwrap(
      claimedAmountWei,
      recipient,
      [...txCommit],
      [...amountProof],
      [...transferPublicInputs],
      [...transferProof],
      snapshotHex,
      ephPubkeyX,
      ephPubkeyY
    );
    return tx.wait();
  }
}

// ---------------------------------------------------------------------------
// Cadence transaction strings — v0.3 router
//
// The Cadence side just translates FCL signers + ABI calldata to the EVM
// proxy via COA. Calldata is built off-chain (e.g. via ethers.js) because
// Cadence's EVM.encodeABIWithSignature struggles with fixed-length arrays.
// ---------------------------------------------------------------------------

/**
 * Cadence tx: cross-VM wrap. Withdraws `amount` FLOW from signer, deposits it
 * into signer's COA, and calls JanusFlow.wrap(txCommit, amountProof) via the COA.
 */
export const TX_WRAP = `
import JanusFlow from 0x5dcbeb41055ec57e
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(
    amount: UFix64,
    txCommit: [UInt256],
    amountProof: [UInt256],
    calldataHex: String
) {
    let vault: @FlowToken.Vault
    let signerRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
        let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("No FlowToken.Vault in signer storage")
        self.vault <- flowVault.withdraw(amount: amount) as! @FlowToken.Vault
    }

    execute {
        JanusFlow.wrap(
            signer: self.signerRef,
            vault: <-self.vault,
            txCommit: txCommit,
            amountProof: amountProof,
            calldataHex: calldataHex
        )
    }
}
`;

/**
 * Cadence tx: cross-VM shieldedTransfer. The recipient is identified via the
 * EVM hex address — pass `toEVMHex` plus the off-chain-built calldata.
 */
export const TX_SHIELDED_TRANSFER = `
import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    toEVMHex: String,
    publicInputs: [UInt256],
    proof: [UInt256],
    calldataHex: String
) {
    prepare(signer: auth(BorrowValue) &Account) {
        JanusFlow.shieldedTransfer(
            signer: signer,
            toEVMHex: toEVMHex,
            publicInputs: publicInputs,
            proof: proof,
            calldataHex: calldataHex
        )
    }
}
`;

/**
 * Cadence tx: cross-VM unwrap. Calls JanusFlow.unwrap on the EVM proxy, which
 * sends FLOW back to `recipientEVMHex` via low-level call.
 */
export const TX_UNWRAP = `
import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    claimedAmount: UFix64,
    recipientEVMHex: String,
    txCommit: [UInt256],
    amountProof: [UInt256],
    transferPublicInputs: [UInt256],
    transferProof: [UInt256],
    calldataHex: String
) {
    prepare(signer: auth(BorrowValue) &Account) {
        JanusFlow.unwrap(
            signer: signer,
            claimedAmount: claimedAmount,
            recipientEVMHex: recipientEVMHex,
            txCommit: txCommit,
            amountProof: amountProof,
            transferPublicInputs: transferPublicInputs,
            transferProof: transferProof,
            calldataHex: calldataHex
        )
    }
}
`;

/**
 * Cadence tx: wrap from COA. Identical privacy semantics to TX_WRAP but the
 * FLOW comes from the signer's Cadence Owned Account (EVM-side balance) rather
 * than their Cadence FlowToken.Vault. Useful for users who hold FLOW on EVM —
 * one click instead of "bridge to vault, then wrap".
 *
 * The temp FlowToken.Vault only exists inside this transaction's scope:
 *   COA -> withdraw attoflow -> @FlowToken.Vault -> JanusFlow.wrap -> COA.
 */
export const TX_WRAP_FROM_COA = `
import JanusFlow from 0x5dcbeb41055ec57e
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868
import EVM from 0x8c5303eaa26202d6

transaction(
    amount: UFix64,
    txCommit: [UInt256],
    amountProof: [UInt256],
    calldataHex: String
) {
    let payment: @FlowToken.Vault
    let signerRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
        let coa = signer.storage
            .borrow<auth(EVM.Withdraw) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("jf_wrap_from_coa: no COA at /storage/evm")
        let flowUnits: UInt64 = UInt64(amount * 100_000_000.0)
        let attoflowU: UInt = UInt(flowUnits) * 10_000_000_000
        let withdrawn <- coa.withdraw(balance: EVM.Balance(attoflow: attoflowU))
        self.payment <- withdrawn
    }

    execute {
        JanusFlow.wrap(
            signer: self.signerRef,
            vault: <- self.payment,
            txCommit: txCommit,
            amountProof: amountProof,
            calldataHex: calldataHex
        )
    }
}
`;

/**
 * Cadence tx: unwrap to vault. Atomic unwrap + sweep COA -> Cadence
 * FlowToken.Vault in a single tx — saves the user a follow-up "withdraw from
 * COA" step. Uses a pre/post COA balance delta to handle any EVM rounding
 * relative to the UFix64-derived claimedAmount.
 */
export const TX_UNWRAP_TO_VAULT = `
import JanusFlow from 0x5dcbeb41055ec57e
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868
import EVM from 0x8c5303eaa26202d6

transaction(
    claimedAmount: UFix64,
    txCommit: [UInt256],
    amountProof: [UInt256],
    transferPublicInputs: [UInt256],
    transferProof: [UInt256],
    calldataHex: String
) {
    let signerRef: auth(BorrowValue) &Account
    let preBalance: UInt
    let recipientEVMHex: String

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
        let coaSnap = signer.storage
            .borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("jf_unwrap_to_vault: no COA at /storage/evm")
        self.preBalance = coaSnap.balance().attoflow
        self.recipientEVMHex = coaSnap.address().toString()
    }

    execute {
        JanusFlow.unwrap(
            signer: self.signerRef,
            claimedAmount: claimedAmount,
            recipientEVMHex: self.recipientEVMHex,
            txCommit: txCommit,
            amountProof: amountProof,
            transferPublicInputs: transferPublicInputs,
            transferProof: transferProof,
            calldataHex: calldataHex
        )
        let coa = self.signerRef.storage
            .borrow<auth(EVM.Withdraw) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("jf_unwrap_to_vault: COA disappeared after unwrap")
        let postBalance = coa.balance().attoflow
        assert(postBalance > self.preBalance, message: "jf_unwrap_to_vault: COA balance did not increase")
        let received: UInt = postBalance - self.preBalance
        let withdrawn <- coa.withdraw(balance: EVM.Balance(attoflow: received))
        let vault = self.signerRef.storage
            .borrow<&FlowToken.Vault>(from: /storage/flowTokenVault)
            ?? panic("jf_unwrap_to_vault: no FlowToken.Vault")
        vault.deposit(from: <- withdrawn)
    }
}
`;

/** Cadence script: get total locked FLOW (from router mirror). */
export const SCRIPT_GET_TOTAL_LOCKED = `
import JanusFlow from 0x5dcbeb41055ec57e

access(all) fun main(): UFix64 {
    return JanusFlow.getTotalLocked()
}
`;

/** Cadence script: get the active JanusFlow impl version string. */
export const SCRIPT_GET_ACTIVE_IMPL_VERSION = `
import JanusFlow from 0x5dcbeb41055ec57e

access(all) fun main(): String {
    return JanusFlow.getActiveImplVersion()
}
`;

/** Cadence script: check whether the router is paused. */
export const SCRIPT_IS_PAUSED = `
import JanusFlow from 0x5dcbeb41055ec57e

access(all) fun main(): Bool {
    return JanusFlow.isPaused()
}
`;

/** Cadence script: get the active EVM target address (canonical JanusFlow proxy). */
export const SCRIPT_GET_EVM_TARGET = `
import JanusFlow from 0x5dcbeb41055ec57e

access(all) fun main(): String {
    return JanusFlow.getJanusTokenAddress()
}
`;

// ---------------------------------------------------------------------------
// Admin Cadence transaction templates (capability-based AdminResource)
// ---------------------------------------------------------------------------

export const TX_ADMIN_PAUSE = `
import JanusFlow from 0x5dcbeb41055ec57e

transaction {
    prepare(admin: auth(BorrowValue) &Account) {
        let adminRef = admin.storage.borrow<&JanusFlow.AdminResource>(
            from: /storage/janusFlowAdmin
        ) ?? panic("No AdminResource in signer storage")
        adminRef.pause()
    }
}
`;

export const TX_ADMIN_UNPAUSE = `
import JanusFlow from 0x5dcbeb41055ec57e

transaction {
    prepare(admin: auth(BorrowValue) &Account) {
        let adminRef = admin.storage.borrow<&JanusFlow.AdminResource>(
            from: /storage/janusFlowAdmin
        ) ?? panic("No AdminResource in signer storage")
        adminRef.unpause()
    }
}
`;

// ---------------------------------------------------------------------------
// Cadence router helper class — read-only FCL wrappers
//
// Wrap+shieldedTransfer+unwrap REQUIRE pre-built calldata for the EVM target,
// so the Cadence helper exposes them as method-shape stubs. Most apps will
// build calldata via ethers.js and pass it through TX_WRAP/TX_SHIELDED_TRANSFER
// /TX_UNWRAP directly with their own FCL authz.
// ---------------------------------------------------------------------------

export interface JanusFlowCadenceOptions {
  network: FlowNetwork;
}

/**
 * Read-only Cadence router helper. Mirrors a subset of the JanusFlow.cdc
 * contract's public scripts. State-changing flows are handled via the
 * exported TX_* templates so apps stay in control of FCL authorization.
 */
export class JanusFlowCadence {
  private readonly network: FlowNetwork;

  constructor(opts: JanusFlowCadenceOptions = { network: "testnet" }) {
    this.network = opts.network;
  }

  /** Configure FCL access node for this network. Call once at app boot. */
  async configure(): Promise<this> {
    const fcl = await import("@onflow/fcl");
    const { NETWORK_CONFIG } = await import("../network/flow-client.js");
    const config = NETWORK_CONFIG[this.network];
    fcl.config({ "accessNode.api": config.flowAccessApi });
    return this;
  }

  /** Read whether the Cadence router is paused. */
  async isPaused(): Promise<boolean> {
    const fcl = await import("@onflow/fcl");
    return fcl.query({ cadence: SCRIPT_IS_PAUSED, args: () => [] }) as Promise<boolean>;
  }

  /** Read the active impl version string ("0.3.0" for the v0.3 router). */
  async getActiveImplVersion(): Promise<string> {
    const fcl = await import("@onflow/fcl");
    return fcl.query({
      cadence: SCRIPT_GET_ACTIVE_IMPL_VERSION,
      args: () => [],
    }) as Promise<string>;
  }

  /** Read the cumulative FLOW wrapped through this router (UFix64 string). */
  async getTotalLocked(): Promise<string> {
    const fcl = await import("@onflow/fcl");
    return fcl.query({
      cadence: SCRIPT_GET_TOTAL_LOCKED,
      args: () => [],
    }) as Promise<string>;
  }

  /** Read the active EVM JanusFlow proxy address. */
  async getEvmTarget(): Promise<string> {
    const fcl = await import("@onflow/fcl");
    return fcl.query({
      cadence: SCRIPT_GET_EVM_TARGET,
      args: () => [],
    }) as Promise<string>;
  }
}

// ---------------------------------------------------------------------------
// Re-export Point + helper types for callers that import only janus-flow
// ---------------------------------------------------------------------------
export type { Point };
