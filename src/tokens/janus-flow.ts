/**
 * tokens/janus-flow.ts — JanusFlow Cadence-native FLOW wrapper SDK
 *
 * JanusFlow wraps Cadence FLOW tokens into confidential Pedersen commitments
 * on the Flow blockchain. All operations go through Cadence transactions
 * (cross-VM: Cadence → EVM for proof verification).
 *
 * Deployed contract:
 *   Cadence: 0x28fef3d1d6a12800 — contract name "JanusFlow" (v1.1.0)
 *   Deploy TX: 9828ed5075d05579765c6aeb4ff3514beb925a70529ccaf12d2a686ff5aa4171
 *
 * Architecture:
 *   - Each user's commitment is stored in the JanusToken EVM slot keyed by their COA address
 *   - wrap: locks FLOW in a Cadence vault, mints EVM commitment via COA
 *   - confidentialTransfer: verifies ZK proof via EVM.dryCall, updates commitments
 *   - unwrap: verifies commitment, releases FLOW from vault
 *
 * v1.1.0 changes from v1.0:
 *   - Per-user COA slot (not a single shared TRACKING_EVM_ADDRESS)
 *   - Homomorphic mintXY (delta arithmetic, not setter)
 *   - babyNeg() helper for point negation via dryCall
 *   - ZK proof via EVM.dryCall (no msg.sender issues)
 *
 * Known test accounts (Flow EVM testnet):
 *   Bob:     Cadence 0xd807a3992d7be612, COA 0x00000000000000000000000250d93efba617e0bf
 *   Charlie: Cadence 0x3c601a443c81e6cd, COA 0x00000000000000000000000249065458581f9bf0
 *   Dave:    Cadence 0xd32d9100e1fe983b, COA 0x0000000000000000000000027b94cfc8a64971cd
 */

import type { CommitmentXY } from "../types/commitment";
import type { FlowNetwork } from "../network/flow-client";
import { NETWORK_CONFIG } from "../network/flow-client";
import { computeCommitment } from "../crypto/commitment";
import { buildTransferProof } from "../crypto/transfer-proof";
import type { TransferProofInput, TransferProofResult } from "./types";

// ---------------------------------------------------------------------------
// Deployment info
// ---------------------------------------------------------------------------

export const JANUS_FLOW_CADENCE_ADDRESS = "0x28fef3d1d6a12800";
export const JANUS_FLOW_CONTRACT_NAME = "JanusFlow";
export const JANUS_FLOW_VERSION = "1.1.0";

// EVM contracts used by JanusFlow (read-only reference)
export const JANUS_FLOW_PRIMITIVES = {
  JanusToken_evm: "0x53F49881A1132FF4F674D2c015e35D5B07Fa1F4A",
  BabyJub: "0x2c40513b343B70f2A0B7e6Ad6F997DDa819D6f07",
  Groth16Verifier: "0x0085F286d89af79EC59E27CD0c5CcD1c55f42Cf5",
};

// ---------------------------------------------------------------------------
// Cadence transaction strings (JanusFlow v1.1.0)
// ---------------------------------------------------------------------------

/** Cadence transaction: wrap FLOW into a confidential commitment */
export const TX_WRAP = `
import JanusFlow from 0x28fef3d1d6a12800
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(amount: UFix64, commitX: UInt256, commitY: UInt256) {
    let vault: @FlowToken.Vault

    prepare(signer: auth(BorrowValue) &Account) {
        let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("No FlowToken.Vault in signer storage")
        self.vault <- flowVault.withdraw(amount: amount) as! @FlowToken.Vault
    }

    execute {
        JanusFlow.wrap(vault: <-self.vault, commitX: commitX, commitY: commitY)
    }
}
`;

/** Cadence transaction: confidential transfer of commitment between users */
export const TX_CONFIDENTIAL_TRANSFER = `
import JanusFlow from 0x28fef3d1d6a12800

transaction(
    recipient: Address,
    oldCommitX: UInt256, oldCommitY: UInt256,
    txCommitX: UInt256, txCommitY: UInt256,
    newCommitX: UInt256, newCommitY: UInt256,
    proof: [UInt256]
) {
    prepare(signer: auth(BorrowValue) &Account) {}
    execute {
        JanusFlow.confidentialTransfer(
            recipient: recipient,
            oldCommit: {"x": oldCommitX, "y": oldCommitY},
            txCommit:  {"x": txCommitX,  "y": txCommitY},
            newCommit: {"x": newCommitX,  "y": newCommitY},
            proof: proof
        )
    }
}
`;

/** Cadence transaction: unwrap FLOW from a confidential commitment */
export const TX_UNWRAP = `
import JanusFlow from 0x28fef3d1d6a12800
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(
    amount: UFix64,
    commitX: UInt256,
    commitY: UInt256,
    recipient: Address
) {
    prepare(signer: auth(BorrowValue) &Account) {}
    execute {
        let vault <- JanusFlow.unwrap(
            amount: amount,
            commitX: commitX,
            commitY: commitY
        )
        let recipientRef = getAccount(recipient)
            .capabilities
            .borrow<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)
            ?? panic("No FlowToken.Receiver on recipient")
        recipientRef.deposit(from: <-vault)
    }
}
`;

/** Cadence script: read a user's commitment from JanusToken EVM slot via COA */
export const SCRIPT_GET_COMMITMENT = `
import JanusFlow from 0x28fef3d1d6a12800

access(all) fun main(user: Address): {String: UInt256} {
    return JanusFlow.getCommitment(user: user)
}
`;

// ---------------------------------------------------------------------------
// JanusFlow class — high-level SDK for Cadence operations
// ---------------------------------------------------------------------------

export interface JanusFlowOptions {
  network: FlowNetwork;
}

/**
 * JanusFlow SDK — wraps/transfers/unwraps FLOW confidentially on Flow Cadence.
 *
 * Operations are executed as Cadence transactions. The caller must provide
 * FCL-compatible authorization functions (from their wallet or a local key).
 */
export class JanusFlow {
  private readonly network: FlowNetwork;

  constructor(opts: JanusFlowOptions = { network: "testnet" }) {
    this.network = opts.network;
  }

  // ---------------------------------------------------------------------------
  // Connection (FCL config)
  // ---------------------------------------------------------------------------

  /** Configure FCL for this network. Call once before any operations. */
  async configure(): Promise<this> {
    const fcl = await import("@onflow/fcl");
    const config = NETWORK_CONFIG[this.network];
    fcl.config({ "accessNode.api": config.flowAccessApi });
    return this;
  }

  // ---------------------------------------------------------------------------
  // Read: get commitment
  // ---------------------------------------------------------------------------

  /**
   * Read a user's current commitment from the JanusToken EVM slot via Cadence script.
   *
   * @param userAddress  Cadence account address (e.g. "0xd807a3992d7be612")
   * @returns            CommitmentXY — identity (0, 1) means zero balance
   */
  async getCommitment(userAddress: string): Promise<CommitmentXY> {
    const fcl = await import("@onflow/fcl");
    const t = await import("@onflow/types");

    const result = await fcl.query({
      cadence: SCRIPT_GET_COMMITMENT,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(userAddress, typeOf.Address),
      ],
    });

    return {
      x: BigInt((result as { x: string; y: string }).x),
      y: BigInt((result as { x: string; y: string }).y),
    };
  }

  // ---------------------------------------------------------------------------
  // Write: wrap
  // ---------------------------------------------------------------------------

  /**
   * Wrap FLOW tokens into a confidential Pedersen commitment.
   *
   * The caller's Cadence FlowToken.Vault is debited by `amount`.
   * A commitment C = Pedersen(amount_in_smallest_unit, blinding) is recorded.
   *
   * @param amount     FLOW amount as UFix64 string (e.g. "10.0")
   * @param amountRaw  Amount as bigint (same value, uint64 representation)
   * @param blinding   128-bit blinding factor (STORE THIS!)
   * @param authz      FCL authorization function for the signer
   * @returns          { txId, commitment }
   */
  async wrap(
    amount: string,
    amountRaw: bigint,
    blinding: bigint,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authz: any
  ): Promise<{ txId: string; commitment: CommitmentXY }> {
    const fcl = await import("@onflow/fcl");
    const t = await import("@onflow/types");

    const commitment = await computeCommitment(amountRaw, blinding);

    const txId = await fcl.mutate({
      cadence: TX_WRAP,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(amount, typeOf.UFix64),
        // @ts-expect-error FCL types are dynamic
        arg(commitment.x.toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(commitment.y.toString(), typeOf.UInt256),
      ],
      proposer: authz,
      payer: authz,
      authorizations: [authz],
      limit: 9999,
    });

    await fcl.tx(txId).onceSealed();
    return { txId, commitment };
  }

  // ---------------------------------------------------------------------------
  // Write: confidentialTransfer
  // ---------------------------------------------------------------------------

  /**
   * Execute a confidential transfer from the caller to a recipient.
   *
   * Generates the ZK proof automatically if circuit paths are provided.
   *
   * @param recipient    Cadence address of the recipient
   * @param proofInput   Transfer parameters + circuit paths
   * @param authz        FCL authorization function for the signer
   * @returns            { txId, proofResult }
   */
  async confidentialTransfer(
    recipient: string,
    proofInput: TransferProofInput,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authz: any
  ): Promise<{ txId: string; proofResult: TransferProofResult }> {
    const fcl = await import("@onflow/fcl");
    const t = await import("@onflow/types");

    const proofResult = await buildTransferProof(proofInput);
    const { commitments, publicInputs, proof } = proofResult;

    // Flatten proof to [UInt256] for Cadence
    const proofArray = [...proof].map((v) => v.toString());

    const txId = await fcl.mutate({
      cadence: TX_CONFIDENTIAL_TRANSFER,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(recipient, typeOf.Address),
        // @ts-expect-error FCL types are dynamic
        arg(publicInputs[0].toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(publicInputs[1].toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(publicInputs[2].toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(publicInputs[3].toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(publicInputs[4].toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(publicInputs[5].toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(proofArray, typeOf.Array(typeOf.UInt256)),
      ],
      proposer: authz,
      payer: authz,
      authorizations: [authz],
      limit: 9999,
    });

    await fcl.tx(txId).onceSealed();
    return { txId, proofResult };
  }

  // ---------------------------------------------------------------------------
  // Write: unwrap
  // ---------------------------------------------------------------------------

  /**
   * Unwrap FLOW from a commitment back to the recipient's Cadence vault.
   *
   * @param amount      FLOW amount as UFix64 string (e.g. "3.0")
   * @param amountRaw   Amount as bigint
   * @param blinding    Blinding factor used when this commitment was created
   * @param recipient   Cadence address to receive the unwrapped FLOW
   * @param authz       FCL authorization function for the signer
   * @returns           { txId, commitment } — the commitment that was burned
   */
  async unwrap(
    amount: string,
    amountRaw: bigint,
    blinding: bigint,
    recipient: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authz: any
  ): Promise<{ txId: string; commitment: CommitmentXY }> {
    const fcl = await import("@onflow/fcl");
    const t = await import("@onflow/types");

    const commitment = await computeCommitment(amountRaw, blinding);

    const txId = await fcl.mutate({
      cadence: TX_UNWRAP,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(amount, typeOf.UFix64),
        // @ts-expect-error FCL types are dynamic
        arg(commitment.x.toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(commitment.y.toString(), typeOf.UInt256),
        // @ts-expect-error FCL types are dynamic
        arg(recipient, typeOf.Address),
      ],
      proposer: authz,
      payer: authz,
      authorizations: [authz],
      limit: 9999,
    });

    await fcl.tx(txId).onceSealed();
    return { txId, commitment };
  }
}
