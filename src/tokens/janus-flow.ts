/**
 * tokens/janus-flow-v2.ts — JanusFlow Cadence wrapper SDK (ElGamal edition)
 *
 * JanusFlow wraps Cadence FLOW tokens into ElGamal-encrypted slots.
 * Cross-VM: Cadence transactions call JanusToken on Flow EVM via COA.
 *
 * Deployed contract:
 *   Cadence: 0x28fef3d1d6a12800 — contract name "JanusFlow" (v2.0.0)
 *
 * Privacy property (from Phase 3 24/24 PASS):
 *   Multiple senders encrypt amounts to the same recipient pubkey.
 *   Recipient decrypts accumulated total without learning per-sender amounts.
 *   On-chain state reveals only that transfers happened, not how much.
 *
 * Architecture vs v1:
 *   v1 (JanusFlow):   Pedersen commitments (C = m*G + r*H), single-base accumulation
 *   v2 (JanusFlow): ElGamal ciphertexts (c1=r*G, c2=m*G+r*PK), multi-sender support
 *
 * The key difference: in v2, any sender can encrypt to any registered recipient PK
 * without needing to coordinate or share blinding factors. Recipients decrypt their
 * own accumulated slot with their secret key + BSGS DLOG solver.
 */

import type { Point } from "../types/commitment";
import type { FlowNetwork } from "../network/flow-client";
import { NETWORK_CONFIG } from "../network/flow-client";
import type { Ciphertext, EncryptProofResult, DecryptProofResult } from "./types";

// ---------------------------------------------------------------------------
// Deployment info
// ---------------------------------------------------------------------------

export const JANUS_FLOW_CADENCE_ADDRESS = "0x28fef3d1d6a12800";
export const JANUS_FLOW_CONTRACT_NAME = "JanusFlow";
export const JANUS_FLOW_VERSION = "0.1.0";

export const JANUS_FLOW_EVM_ADDRESS = "0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D";

// ---------------------------------------------------------------------------
// Cadence transaction strings — JanusFlow
// ---------------------------------------------------------------------------

/** Cadence tx: register BabyJubJub pubkey (one-time setup per account) */
export const TX_REGISTER_PUBKEY = `
import JanusFlow from 0x28fef3d1d6a12800

transaction(pkx: UInt256, pky: UInt256) {
    prepare(signer: auth(BorrowValue) &Account) {}
    execute {
        JanusFlow.registerPubkey(pkx: pkx, pky: pky)
    }
}
`;

/** Cadence tx: wrap FLOW and encrypt amount to a recipient's pubkey */
export const TX_WRAP_AND_ENCRYPT = `
import JanusFlow from 0x28fef3d1d6a12800
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
export const TX_CONFIDENTIAL_TRANSFER_V2 = `
import JanusFlow from 0x28fef3d1d6a12800

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
import JanusFlow from 0x28fef3d1d6a12800
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
import JanusFlow from 0x28fef3d1d6a12800

access(all) fun main(user: Address): {String: UInt256} {
    return JanusFlow.getSlot(user: user)
}
`;

/** Cadence script: read a user's registered pubkey */
export const SCRIPT_GET_PUBKEY = `
import JanusFlow from 0x28fef3d1d6a12800

access(all) fun main(user: Address): {String: UInt256} {
    return JanusFlow.getPubkey(user: user)
}
`;

// ---------------------------------------------------------------------------
// JanusFlow class
// ---------------------------------------------------------------------------

export interface JanusFlowOptions {
  network: FlowNetwork;
}

/**
 * JanusFlow SDK — ElGamal-based confidential FLOW wrapping via Cadence.
 *
 * Operations execute as Cadence transactions (cross-VM: Cadence → EVM via COA).
 * Callers provide FCL-compatible authorization functions.
 *
 * Upgrade guide from v1 JanusFlow:
 *   - `sdk.wrap(amount, amountRaw, blinding, authz)` →
 *     `sdk.wrapAndEncrypt(amount, recipient, proofResult, authz)`
 *   - `sdk.confidentialTransfer(recipient, proofInput, authz)` →
 *     `sdk.confidentialTransfer(recipient, proofResult, authz)`
 *   - v1 blinding factors → v2 ElGamal keypair (derive once via deriveKeypair())
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
      cadence: TX_CONFIDENTIAL_TRANSFER_V2,
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
}
