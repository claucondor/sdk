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
 * v0.3 production deployment (Flow EVM testnet):
 *   JanusFlow proxy:               0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078
 *   JanusFlow impl:                0x9321dF5884021D7E19Ad0EB5F582f8E2A70236eC
 *   AmountDiscloseVerifier:        0xD0ED3936530258C278f5357C1dB709ad34768352
 *   ConfidentialTransferVerifier:  0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B
 *   BabyJub (re-used):             0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
 *   Owner (admin COA):             0x0000000000000000000000022f6b30af48a94787
 *
 * Cadence router (v0.3, cross-VM wrapper):
 *   Address:        0x5dcbeb41055ec57e (router) — calls the EVM proxy via COA
 *   Contract:       JanusFlow
 *
 * MAX_WRAP per call: 18 FLOW (2^64 attoFLOW headroom for the circuit range proof).
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

/** v0.3 JanusFlow implementation contract on Flow EVM testnet. */
export const JANUS_FLOW_EVM_IMPL_ADDRESS = "0x9321dF5884021D7E19Ad0EB5F582f8E2A70236eC";

/** v0.3 Cadence router address (cross-VM wrapper around the EVM proxy). */
export const JANUS_FLOW_CADENCE_ADDRESS = "0x5dcbeb41055ec57e";

/** Cadence contract name at the router address. */
export const JANUS_FLOW_CONTRACT_NAME = "JanusFlow";

/** SDK version identifier. Tracks the on-chain `getActiveImplVersion()` value. */
export const JANUS_FLOW_VERSION = "0.3.0";

/** Per-call wrap cap (matches contract's MAX_WRAP — ~18 FLOW in attoFLOW). */
export const JANUS_FLOW_MAX_WRAP_ATTOFLOW = 18_000_000_000_000_000_000n;

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

/** ABI fragments for JanusFlow's wrap/unwrap concrete signatures + MAX_WRAP. */
export const JANUS_FLOW_EXTRA_ABI = [
  "function MAX_WRAP() view returns (uint256)",
  "function wrap(uint256[2] txCommit, uint256[8] amountProof) external payable",
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof) external",
] as const;

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
   * The on-chain verifier checks that `txCommit` is a Pedersen commitment of
   * exactly `amountWei` (in attoFLOW = wei) with the supplied (private) blinding.
   * Build `txCommit` + `amountProof` via `buildAmountDiscloseProof()`.
   *
   * msg.value is VISIBLE BY DESIGN — this is the wrap boundary.
   *
   * @param params.amountWei    msg.value (attoFLOW). Must equal the proof's
   *                            claimed_amount and be <= MAX_WRAP.
   * @param params.txCommit     [Cx, Cy] — Pedersen commit of amountWei
   * @param params.amountProof  uint256[8] — pi_b Fp2-swapped Groth16 proof
   */
  async wrap(params: {
    amountWei: bigint;
    txCommit: readonly [bigint, bigint] | readonly bigint[];
    amountProof:
      | readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
      | readonly bigint[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<any> {
    const { amountWei, txCommit, amountProof } = params;
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
    const tx = await this._contract().wrap(
      [...txCommit],
      [...amountProof],
      { value: amountWei }
    );
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // Write: unwrap — releases native FLOW with ZK proofs
  // ---------------------------------------------------------------------------

  /**
   * Release `claimedAmountWei` of native FLOW to `recipient`. The sender's
   * residual commitment stays hidden — only the claimed amount + recipient
   * are leaked at the boundary.
   *
   * Requires TWO proofs:
   *   1. amount-disclose: `txCommit` commits to `claimedAmountWei`.
   *   2. confidential-transfer: caller's storage commitment can be split into
   *      `txCommit + C_new`.
   *
   * The contract enforces `transferPublicInputs[0..1] == sender's stored commitment`
   * and `transferPublicInputs[2..3] == txCommit` — keep these consistent or
   * the call reverts.
   *
   * @param params.claimedAmountWei  attoFLOW being released
   * @param params.recipient         EVM address that receives the FLOW
   * @param params.txCommit          [Cx, Cy] of claimedAmountWei
   * @param params.amountProof       uint256[8] amount-disclose proof
   * @param params.transferPublicInputs  uint256[6] — [C_old, C_tx, C_new]
   * @param params.transferProof     uint256[8] confidential-transfer proof
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<any> {
    const {
      claimedAmountWei,
      recipient,
      txCommit,
      amountProof,
      transferPublicInputs,
      transferProof,
    } = params;
    if (txCommit.length !== 2) throw new Error("JanusFlow.unwrap: txCommit must be length 2");
    if (amountProof.length !== 8) throw new Error("JanusFlow.unwrap: amountProof must be length 8");
    if (transferPublicInputs.length !== 6)
      throw new Error("JanusFlow.unwrap: transferPublicInputs must be length 6");
    if (transferProof.length !== 8)
      throw new Error("JanusFlow.unwrap: transferProof must be length 8");
    if (claimedAmountWei <= 0n)
      throw new Error(`JanusFlow.unwrap: claimedAmountWei must be > 0, got ${claimedAmountWei}`);

    const tx = await this._contract().unwrap(
      claimedAmountWei,
      recipient,
      [...txCommit],
      [...amountProof],
      [...transferPublicInputs],
      [...transferProof]
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

    prepare(signer: auth(BorrowValue) &Account) {
        let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("No FlowToken.Vault in signer storage")
        self.vault <- flowVault.withdraw(amount: amount) as! @FlowToken.Vault
    }

    execute {
        JanusFlow.wrap(
            signer: getAuthAccount<auth(BorrowValue) &Account>(0x0),
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
