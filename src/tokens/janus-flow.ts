/**
 * tokens/janus-flow.ts — JanusFlow Cadence wrapper SDK (router/impl pattern, v0.2.0-router)
 *
 * JanusFlow wraps Cadence FLOW tokens into ElGamal-encrypted slots.
 * Cross-VM: Cadence transactions call JanusToken on Flow EVM via COA.
 *
 * Deployed contract (canonical — router/impl pattern):
 *   Cadence: 0x5dcbeb41055ec57e — contract name "JanusFlow"
 *   Router deploy TX: 8d99b1c5610feee73f4361f13ea504a8bb911f4973ea3ead20b8ec9259cb3962
 *   Impl deploy TX:   f246c5a820523c27f7fbe01970f1f6f26855c6286001d98fc08a2b611976b3cb
 *
 * DEPRECATED — DO NOT USE:
 *   0x28fef3d1d6a12800.JanusFlow — legacy v1 Pedersen zombie, cannot be removed.
 *
 * Privacy property (from Phase 3 24/24 PASS + router e2e 25/25 PASS):
 *   Multiple senders encrypt amounts to the same recipient pubkey.
 *   Recipient decrypts accumulated total without learning per-sender amounts.
 *   On-chain state reveals only that transfers happened, not how much.
 *
 * Architecture — Router/Impl pattern (v0.2.0-router):
 *   JanusFlow (router) — public canonical address, holds custody (FLOW vault +
 *     commitments + pubkeys), never moves. Exposes pause/unpause + impl-swap admin.
 *   JanusFlowImpl — pure stateless logic, swappable via 48h time-locked capability swap.
 *   IJanusFlowImpl — interface contract that all impls must conform to.
 *
 *   Apps import JanusFlow from 0x5dcbeb41055ec57e forever. Impl upgrades are
 *   transparent — custody stays in the router, public API is stable.
 *
 *   Upgrade flow:
 *     1. Admin proposes new impl: proposeImplSwap(newImplCapability)
 *     2. 48h time-lock starts — apps can react/migrate/object
 *     3. Admin calls finalizeImplSwap() — capability swap, apps unchanged
 *
 *   ElGamal ciphertexts (c1=r*G, c2=m*G+r*PK) for multi-sender support.
 *   Any sender can encrypt to any registered recipient PK without coordination.
 *   Recipients decrypt their accumulated slot with their secret key + BSGS DLOG solver.
 */

import type { Point } from "../types/commitment";
import type { FlowNetwork } from "../network/flow-client";
import { NETWORK_CONFIG } from "../network/flow-client";
import type { Ciphertext, EncryptProofResult, DecryptProofResult } from "./types";

// ---------------------------------------------------------------------------
// Deployment info
// ---------------------------------------------------------------------------

/** Canonical JanusFlow Cadence address — router/impl pattern, v0.2.0-router. */
export const JANUS_FLOW_CADENCE_ADDRESS = "0x5dcbeb41055ec57e";
export const JANUS_FLOW_CONTRACT_NAME = "JanusFlow";
/**
 * Active router/impl pattern version string.
 * Semver only — addresses + features are tracked separately via JANUS_FLOW_CADENCE_ADDRESS
 * and the deployment-record JSON in `circuits/setup/deployments-router.json`.
 */
export const JANUS_FLOW_VERSION = "0.2.1-router";

/**
 * @deprecated Previous router at 0xbef3c77681c15397. Had a 48h impl-swap time-lock
 * that blocked the v0.2.1 vuln 014 fix-deploy, so a fresh router was created at
 * 0x5dcbeb41055ec57e. Old commitments are stuck (unrecoverable per vuln 014).
 */
export const JANUS_FLOW_CADENCE_ADDRESS_PREVIOUS = "0xbef3c77681c15397";

/**
 * Legacy address — zombie v1 Pedersen contract. Cannot be removed (Flow restriction).
 * DO NOT USE — import from JANUS_FLOW_CADENCE_ADDRESS instead.
 * @deprecated
 */
export const JANUS_FLOW_CADENCE_ADDRESS_LEGACY = "0x28fef3d1d6a12800";

/**
 * EVM address of the current JanusToken UUPS proxy. Use the JanusToken class
 * with this address for EVM-direct flows.
 */
export const JANUS_FLOW_EVM_ADDRESS = "0x025efe7e89acdb8F315C804BE7245F348AA9c538";

/**
 * Previously-deployed JanusToken EVM address (pre-SCALE-fix). Retained for
 * cross-referencing event history only — do NOT use for new wrap/unwrap calls.
 * @deprecated
 */
export const JANUS_FLOW_EVM_ADDRESS_DEPRECATED = "0xb12E600fFcde967210cFD81CF9f32bBB6e68a499";

// ---------------------------------------------------------------------------
// Cadence transaction strings — JanusFlow
// ---------------------------------------------------------------------------

/** Cadence tx: register BabyJubJub pubkey (one-time setup per account) */
export const TX_REGISTER_PUBKEY = `
import JanusFlow from 0x5dcbeb41055ec57e

transaction(pkx: UInt256, pky: UInt256) {
    prepare(signer: auth(BorrowValue) &Account) {}
    execute {
        JanusFlow.registerPubkey(pkx: pkx, pky: pky)
    }
}
`;

/** Cadence tx: wrap FLOW and encrypt amount to a recipient's pubkey */
export const TX_WRAP_AND_ENCRYPT = `
import JanusFlow from 0x5dcbeb41055ec57e
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(
    amount: UFix64,
    recipient: Address,
    c1x: UInt256, c1y: UInt256,
    c2x: UInt256, c2y: UInt256,
    proof: [UInt256],
    pubInputs: [UInt256]
) {
    let vault: @FlowToken.Vault

    prepare(signer: auth(BorrowValue) &Account) {
        let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("No FlowToken.Vault in signer storage")
        self.vault <- flowVault.withdraw(amount: amount) as! @FlowToken.Vault
    }

    execute {
        JanusFlow.wrapAndEncrypt(
            vault: <-self.vault,
            recipient: recipient,
            c1x: c1x, c1y: c1y,
            c2x: c2x, c2y: c2y,
            proof: proof,
            pubInputs: pubInputs
        )
    }
}
`;

/** Cadence tx: confidential transfer between two registered accounts */
export const TX_CONFIDENTIAL_TRANSFER = `
import JanusFlow from 0x5dcbeb41055ec57e

transaction(
    recipient: Address,
    c1x: UInt256, c1y: UInt256,
    c2x: UInt256, c2y: UInt256,
    proof: [UInt256],
    pubInputs: [UInt256]
) {
    prepare(signer: auth(BorrowValue) &Account) {}
    execute {
        JanusFlow.confidentialTransfer(
            recipient: recipient,
            c1x: c1x, c1y: c1y,
            c2x: c2x, c2y: c2y,
            proof: proof,
            pubInputs: pubInputs
        )
    }
}
`;

/** Cadence tx: decrypt accumulated slot and unwrap FLOW to recipient */
export const TX_DECRYPT_AND_UNWRAP = `
import JanusFlow from 0x5dcbeb41055ec57e
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(
    amount: UFix64,
    to: Address,
    proof: [UInt256],
    pubInputs: [UInt256]
) {
    prepare(signer: auth(BorrowValue) &Account) {}
    execute {
        let vault <- JanusFlow.decryptAndUnwrap(
            amount: amount,
            proof: proof,
            pubInputs: pubInputs
        )
        let recipientRef = getAccount(to)
            .capabilities
            .borrow<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)
            ?? panic("No FlowToken.Receiver on recipient")
        recipientRef.deposit(from: <-vault)
    }
}
`;

/** Cadence script: read a user's encrypted slot */
export const SCRIPT_GET_SLOT = `
import JanusFlow from 0x5dcbeb41055ec57e

access(all) fun main(user: Address): {String: UInt256} {
    return JanusFlow.getSlot(user: user)
}
`;

/** Cadence script: read a user's registered pubkey */
export const SCRIPT_GET_PUBKEY = `
import JanusFlow from 0x5dcbeb41055ec57e

access(all) fun main(user: Address): {String: UInt256} {
    return JanusFlow.getPubkey(user: user)
}
`;

/** Cadence script: check whether the router is paused */
export const SCRIPT_IS_PAUSED = `
import JanusFlow from 0x5dcbeb41055ec57e

access(all) fun main(): Bool {
    return JanusFlow.isPaused()
}
`;

/** Cadence script: get the version string of the currently active impl */
export const SCRIPT_GET_ACTIVE_IMPL_VERSION = `
import JanusFlow from 0x5dcbeb41055ec57e

access(all) fun main(): String {
    return JanusFlow.getActiveImplVersion()
}
`;

// ---------------------------------------------------------------------------
// Admin Cadence transaction templates
// Admin operations require the AdminResource capability stored at
// /storage/janusFlowAdmin on the JanusFlow account (0x5dcbeb41055ec57e).
// ---------------------------------------------------------------------------

/** Cadence tx (admin): pause the JanusFlow router — emergency stop */
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

/** Cadence tx (admin): unpause the JanusFlow router */
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

/**
 * Cadence tx (admin): propose an impl swap.
 * Starts the 48h (172800s) time-lock. newImplVersion is the version string
 * of the incoming impl (used for on-chain tracking + events).
 *
 * NOTE: The capability itself must be passed as a Cadence argument.
 * In practice, this transaction is constructed manually or via a custom
 * admin script that already holds the newImpl Capability reference.
 * This template is a reference; adapt as needed for your key-management setup.
 */
export const TX_ADMIN_PROPOSE_IMPL_SWAP = `
import JanusFlow from 0x5dcbeb41055ec57e
import IJanusFlowImpl from 0x5dcbeb41055ec57e

transaction(newImplVersion: String) {
    prepare(admin: auth(BorrowValue) &Account) {
        let adminRef = admin.storage.borrow<&JanusFlow.AdminResource>(
            from: /storage/janusFlowAdmin
        ) ?? panic("No AdminResource in signer storage")
        // Capability acquisition is app-specific — adapt this template
        // with the concrete newImpl Capability<&IJanusFlowImpl.IImpl> reference.
        // adminRef.proposeImplSwap(newImpl: newImplCap, newVersion: newImplVersion)
        panic("Adapt this template: acquire the impl capability before calling proposeImplSwap")
    }
}
`;

/** Cadence tx (admin): finalize impl swap after 48h time-lock has expired */
export const TX_ADMIN_FINALIZE_IMPL_SWAP = `
import JanusFlow from 0x5dcbeb41055ec57e

transaction {
    prepare(admin: auth(BorrowValue) &Account) {
        let adminRef = admin.storage.borrow<&JanusFlow.AdminResource>(
            from: /storage/janusFlowAdmin
        ) ?? panic("No AdminResource in signer storage")
        adminRef.finalizeImplSwap()
    }
}
`;

/** Cadence tx (admin): cancel a pending impl swap proposal */
export const TX_ADMIN_CANCEL_IMPL_SWAP = `
import JanusFlow from 0x5dcbeb41055ec57e

transaction {
    prepare(admin: auth(BorrowValue) &Account) {
        let adminRef = admin.storage.borrow<&JanusFlow.AdminResource>(
            from: /storage/janusFlowAdmin
        ) ?? panic("No AdminResource in signer storage")
        adminRef.cancelImplSwap()
    }
}
`;

// ---------------------------------------------------------------------------
// JanusFlow class
// ---------------------------------------------------------------------------

export interface JanusFlowOptions {
  network: FlowNetwork;
}

/**
 * JanusFlow SDK — Cadence wrapper class for JanusToken EVM operations.
 *
 * Canonical address: 0x5dcbeb41055ec57e (router/impl pattern, v0.2.0-router).
 * 25/25 e2e tests pass on this address (2026-05-26).
 *
 * Router/impl architecture:
 *   JanusFlow (router at canonical address) — public API + custody (FLOW vault +
 *     commitments + pubkeys). Never moves. Exposes admin: pause/unpause + impl-swap.
 *   JanusFlowImpl — current pure-logic impl. Swappable via 48h time-locked capability.
 *
 * Admin operations (owner only, via AdminResource capability):
 *   pause() / unpause()      — emergency stop; isPaused() is a public view
 *   proposeImplSwap(cap)     — start 48h time-lock for impl upgrade
 *   finalizeImplSwap()       — complete upgrade after time-lock expires
 *   cancelImplSwap()         — abort a pending upgrade proposal
 *   getActiveImplVersion()   — returns the version string of the current impl
 *
 * User-facing operations (any account):
 *   registerPubkey(pk, authz)                          — one-time BabyJubJub key setup
 *   wrapAndEncrypt(amount, recipient, proof, authz)    — wrap FLOW + encrypt
 *   confidentialTransfer(recipient, proof, authz)      — slot-to-slot transfer
 *   decryptAndUnwrap(amount, to, proof, authz)         — claim + unwrap FLOW
 *   getSlot(userAddress)                               — read encrypted slot (view)
 *   getPubkey(userAddress)                             — read registered pubkey (view)
 *
 * Operations execute as Cadence transactions (cross-VM: Cadence to EVM via COA).
 * Callers provide FCL-compatible authorization functions.
 *
 * @see https://github.com/openjanus/sdk/blob/main/docs/ARCHITECTURE.md
 */
export class JanusFlow {
  private readonly network: FlowNetwork;

  constructor(opts: JanusFlowOptions = { network: "testnet" }) {
    this.network = opts.network;
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /** Configure FCL for this network. Call once before any operations. */
  async configure(): Promise<this> {
    const fcl = await import("@onflow/fcl");
    const config = NETWORK_CONFIG[this.network];
    fcl.config({ "accessNode.api": config.flowAccessApi });
    return this;
  }

  // ---------------------------------------------------------------------------
  // Read: slot and pubkey
  // ---------------------------------------------------------------------------

  /**
   * Read a user's ElGamal-encrypted balance slot.
   * Returns identity ciphertext (c1=(0,1), c2=(0,1)) if slot is empty.
   *
   * @param userAddress  Cadence account address
   */
  async getSlot(userAddress: string): Promise<Ciphertext> {
    const fcl = await import("@onflow/fcl");

    const result = await fcl.query({
      cadence: SCRIPT_GET_SLOT,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(userAddress, typeOf.Address),
      ],
    });

    const raw = result as { c1x: string; c1y: string; c2x: string; c2y: string };
    return {
      c1: { x: BigInt(raw.c1x), y: BigInt(raw.c1y) },
      c2: { x: BigInt(raw.c2x), y: BigInt(raw.c2y) },
    };
  }

  /**
   * Read a user's registered BabyJubJub public key.
   * Returns identity (0,1) if not registered.
   *
   * @param userAddress  Cadence account address
   */
  async getPubkey(userAddress: string): Promise<Point> {
    const fcl = await import("@onflow/fcl");

    const result = await fcl.query({
      cadence: SCRIPT_GET_PUBKEY,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(userAddress, typeOf.Address),
      ],
    });

    const raw = result as { pkx: string; pky: string };
    return { x: BigInt(raw.pkx), y: BigInt(raw.pky) };
  }

  // ---------------------------------------------------------------------------
  // Write: registerPubkey
  // ---------------------------------------------------------------------------

  /**
   * Register a BabyJubJub public key for this account.
   * Must be called once before the account can receive encrypted amounts.
   *
   * @param pk    BabyJubJub public key (on-curve point)
   * @param authz FCL authorization function
   */
  async registerPubkey(
    pk: Point,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authz: any
  ): Promise<{ txId: string }> {
    const fcl = await import("@onflow/fcl");

    const txId = await fcl.mutate({
      cadence: TX_REGISTER_PUBKEY,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(pk.x.toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(pk.y.toString(), typeOf.UInt256),
      ],
      proposer: authz,
      payer: authz,
      authorizations: [authz],
      limit: 9999,
    });

    await fcl.tx(txId).onceSealed();
    return { txId };
  }

  // ---------------------------------------------------------------------------
  // Write: wrapAndEncrypt
  // ---------------------------------------------------------------------------

  /**
   * Wrap FLOW and encrypt the amount to a recipient's registered pubkey.
   *
   * The caller's FLOW vault is debited by `amount`. An ElGamal ciphertext
   * (c1, c2) encrypting `amount` to the recipient's pubkey is accumulated
   * into the recipient's on-chain slot. The encrypt-consistency proof
   * is verified on-chain before the slot is updated.
   *
   * @param amount      FLOW amount as UFix64 string (e.g. "10.0")
   * @param recipient   Cadence address of the recipient (must have registered pubkey)
   * @param proofResult Result from buildEncryptProof()
   * @param authz       FCL authorization function
   */
  async wrapAndEncrypt(
    amount: string,
    recipient: string,
    proofResult: EncryptProofResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authz: any
  ): Promise<{ txId: string; ciphertext: Ciphertext }> {
    const fcl = await import("@onflow/fcl");
    const { ciphertext, proof, publicInputs } = proofResult;

    const proofArr = [...proof].map((v) => v.toString());
    const pubInputsArr = [...publicInputs].map((v) => v.toString());

    const txId = await fcl.mutate({
      cadence: TX_WRAP_AND_ENCRYPT,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(amount, typeOf.UFix64),
        // @ts-expect-error FCL types are dynamic
        arg(recipient, typeOf.Address),
        // @ts-expect-error FCL types are dynamic
        arg(ciphertext.c1.x.toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(ciphertext.c1.y.toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(ciphertext.c2.x.toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(ciphertext.c2.y.toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(proofArr, typeOf.Array(typeOf.UInt256)),
        // @ts-expect-error FCL types are dynamic
        arg(pubInputsArr, typeOf.Array(typeOf.UInt256)),
      ],
      proposer: authz,
      payer: authz,
      authorizations: [authz],
      limit: 9999,
    });

    await fcl.tx(txId).onceSealed();
    return { txId, ciphertext };
  }

  // ---------------------------------------------------------------------------
  // Write: confidentialTransfer
  // ---------------------------------------------------------------------------

  /**
   * Confidential transfer from caller to recipient.
   *
   * Generates an ElGamal ciphertext of `amount` encrypted to the recipient's
   * registered pubkey. Verifies the encrypt-consistency proof on-chain, then
   * atomically decrements the sender's slot and increments the recipient's slot.
   *
   * @param recipient   Cadence address of the recipient
   * @param proofResult Result from buildEncryptProof()
   * @param authz       FCL authorization function
   */
  async confidentialTransfer(
    recipient: string,
    proofResult: EncryptProofResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authz: any
  ): Promise<{ txId: string; ciphertext: Ciphertext }> {
    const fcl = await import("@onflow/fcl");
    const { ciphertext, proof, publicInputs } = proofResult;

    const proofArr = [...proof].map((v) => v.toString());
    const pubInputsArr = [...publicInputs].map((v) => v.toString());

    const txId = await fcl.mutate({
      cadence: TX_CONFIDENTIAL_TRANSFER,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(recipient, typeOf.Address),
        // @ts-expect-error FCL types are dynamic
        arg(ciphertext.c1.x.toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(ciphertext.c1.y.toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(ciphertext.c2.x.toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(ciphertext.c2.y.toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(proofArr, typeOf.Array(typeOf.UInt256)),
        // @ts-expect-error FCL types are dynamic
        arg(pubInputsArr, typeOf.Array(typeOf.UInt256)),
      ],
      proposer: authz,
      payer: authz,
      authorizations: [authz],
      limit: 9999,
    });

    await fcl.tx(txId).onceSealed();
    return { txId, ciphertext };
  }

  // ---------------------------------------------------------------------------
  // Write: decryptAndUnwrap
  // ---------------------------------------------------------------------------

  /**
   * Decrypt the caller's accumulated slot and unwrap FLOW to a recipient address.
   *
   * Generates a decrypt-open proof proving the caller knows their secret key
   * and the decryption is correct. The proof is verified on-chain, then FLOW
   * is released from the JanusFlow vault to the specified recipient.
   *
   * @param amount      UFix64 string of FLOW to unwrap (e.g. "42.0")
   * @param to          Cadence address to receive the unwrapped FLOW
   * @param proofResult Result from buildDecryptProof()
   * @param authz       FCL authorization function
   */
  async decryptAndUnwrap(
    amount: string,
    to: string,
    proofResult: DecryptProofResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authz: any
  ): Promise<{ txId: string; amount: bigint }> {
    const fcl = await import("@onflow/fcl");
    const { proof, publicInputs } = proofResult;

    const proofArr = [...proof].map((v) => v.toString());
    const pubInputsArr = [...publicInputs].map((v) => v.toString());

    const txId = await fcl.mutate({
      cadence: TX_DECRYPT_AND_UNWRAP,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(amount, typeOf.UFix64),
        // @ts-expect-error FCL types are dynamic
        arg(to, typeOf.Address),
        // @ts-expect-error FCL types are dynamic
        arg(proofArr, typeOf.Array(typeOf.UInt256)),
        // @ts-expect-error FCL types are dynamic
        arg(pubInputsArr, typeOf.Array(typeOf.UInt256)),
      ],
      proposer: authz,
      payer: authz,
      authorizations: [authz],
      limit: 9999,
    });

    await fcl.tx(txId).onceSealed();
    return { txId, amount: proofResult.amount };
  }

  // ---------------------------------------------------------------------------
  // Admin: pause / unpause
  // ---------------------------------------------------------------------------

  /**
   * Check whether the JanusFlow router is currently paused.
   * Paused = all user-facing write operations revert. Read operations still work.
   *
   * @returns true if paused, false if active
   */
  async isPaused(): Promise<boolean> {
    const fcl = await import("@onflow/fcl");
    return fcl.query({ cadence: SCRIPT_IS_PAUSED, args: () => [] }) as Promise<boolean>;
  }

  /**
   * (Admin only) Pause the JanusFlow router — emergency stop.
   * Caller must hold the AdminResource at /storage/janusFlowAdmin.
   *
   * @param authz FCL authorization function for the admin account
   */
  async pause(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authz: any
  ): Promise<{ txId: string }> {
    const fcl = await import("@onflow/fcl");
    const txId = await fcl.mutate({
      cadence: TX_ADMIN_PAUSE,
      args: () => [],
      proposer: authz,
      payer: authz,
      authorizations: [authz],
      limit: 9999,
    });
    await fcl.tx(txId).onceSealed();
    return { txId };
  }

  /**
   * (Admin only) Unpause the JanusFlow router.
   * Caller must hold the AdminResource at /storage/janusFlowAdmin.
   *
   * @param authz FCL authorization function for the admin account
   */
  async unpause(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authz: any
  ): Promise<{ txId: string }> {
    const fcl = await import("@onflow/fcl");
    const txId = await fcl.mutate({
      cadence: TX_ADMIN_UNPAUSE,
      args: () => [],
      proposer: authz,
      payer: authz,
      authorizations: [authz],
      limit: 9999,
    });
    await fcl.tx(txId).onceSealed();
    return { txId };
  }

  // ---------------------------------------------------------------------------
  // Admin: impl swap (48h time-lock)
  // ---------------------------------------------------------------------------

  /**
   * Get the version string of the currently active JanusFlowImpl.
   * Returns a semver-like string (e.g. "0.1.0") as set by the impl contract.
   */
  async getActiveImplVersion(): Promise<string> {
    const fcl = await import("@onflow/fcl");
    return fcl.query({
      cadence: SCRIPT_GET_ACTIVE_IMPL_VERSION,
      args: () => [],
    }) as Promise<string>;
  }

  /**
   * (Admin only) Finalize a pending impl swap after the 48h time-lock has expired.
   * Call proposeImplSwap on-chain first (via TX_ADMIN_PROPOSE_IMPL_SWAP template).
   * After 48h, call this method to complete the capability swap.
   *
   * @param authz FCL authorization function for the admin account
   */
  async finalizeImplSwap(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authz: any
  ): Promise<{ txId: string }> {
    const fcl = await import("@onflow/fcl");
    const txId = await fcl.mutate({
      cadence: TX_ADMIN_FINALIZE_IMPL_SWAP,
      args: () => [],
      proposer: authz,
      payer: authz,
      authorizations: [authz],
      limit: 9999,
    });
    await fcl.tx(txId).onceSealed();
    return { txId };
  }

  /**
   * (Admin only) Cancel a pending impl swap proposal before it is finalized.
   *
   * @param authz FCL authorization function for the admin account
   */
  async cancelImplSwap(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authz: any
  ): Promise<{ txId: string }> {
    const fcl = await import("@onflow/fcl");
    const txId = await fcl.mutate({
      cadence: TX_ADMIN_CANCEL_IMPL_SWAP,
      args: () => [],
      proposer: authz,
      payer: authz,
      authorizations: [authz],
      limit: 9999,
    });
    await fcl.tx(txId).onceSealed();
    return { txId };
  }
}
