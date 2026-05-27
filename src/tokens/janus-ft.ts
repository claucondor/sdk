/**
 * tokens/janus-ft.ts — JanusFT Cadence-side confidential FungibleToken wrapper (v0.4)
 *
 * JanusFT is a pure-Cadence confidential-amount wrapper for any FungibleToken
 * vault. Same privacy SHAPE as JanusERC20 — wrap takes custody of an FT amount
 * and binds it to a Pedersen commitment; shieldedTransfer moves a hidden
 * amount between commitment holders; unwrap releases the underlying vault.
 *
 * v0.4 ships the lab-grade port: babyAdd / babyNegate are CADENCE STUBS, NOT
 * real BabyJubJub point ops, and on-chain proofs are accepted opaquely
 * (length > 0 check only). The privacy properties under test are STRUCTURAL
 * (calldata, events, storage shape). Cross-VM verification + real BabyJub
 * arrive in v0.5.
 *
 * v0.4 canonical deployment (Flow Cadence testnet):
 *   JanusFT account:    0xbef3c77681c15397 (openjanus-flow)
 *   Contract name:      JanusFT
 *   Import path:        import JanusFT from 0xbef3c77681c15397
 *   Default underlying: A.7e60df042a9c0868.FlowToken.Vault (testnet FlowToken)
 *
 * Smoke test mirror (for repeatable structural privacy tests):
 *   0x3c601a443c81e6cd (charlie) — byte-identical contract; reset between runs
 *   via Admin.resetCommitmentsForTestingOnly().
 *
 * Apps consume this module via FCL — pass the exported TX_FT_* strings to
 * fcl.mutate({ cadence: TX_FT_WRAP, args: ... }).
 */

import type { FlowNetwork } from "../network/flow-client";

// ---------------------------------------------------------------------------
// Canonical v0.4 deployment addresses
// ---------------------------------------------------------------------------

/** Canonical JanusFT Cadence address on testnet. */
export const JANUS_FT_CADENCE_ADDRESS = "0xbef3c77681c15397";

/** Cadence contract name at the canonical address. */
export const JANUS_FT_CONTRACT_NAME = "JanusFT";

/** SDK version identifier for the JanusFT surface. */
export const JANUS_FT_VERSION = "0.4.0";

/** Default underlying FungibleToken vault type identifier (testnet FlowToken). */
export const JANUS_FT_DEFAULT_UNDERLYING_TYPE = "A.7e60df042a9c0868.FlowToken.Vault";

/** Smoke-test mirror address (charlie) — used by the contracts package's smoke. */
export const JANUS_FT_SMOKE_MIRROR_ADDRESS = "0x3c601a443c81e6cd";

// ---------------------------------------------------------------------------
// Cadence transaction templates — keep canonical address inline so apps
// import the strings without needing to template them.
//
// To target a different deployment (e.g. mainnet or the smoke mirror), use
// `buildJanusFTTx(addr, kind)` below.
// ---------------------------------------------------------------------------

/** One-time setup: create the JanusFT CommitmentRegistry on the signer's account. */
export const TX_FT_SETUP_REGISTRY = `import JanusFT from 0xbef3c77681c15397
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction {
    prepare(signer: auth(SaveValue, BorrowValue, Capabilities) &Account) {
        if signer.storage.borrow<&JanusFT.CommitmentRegistry>(from: JanusFT.CommitmentRegistryStoragePath) != nil {
            return
        }
        let emptyVault <- FlowToken.createEmptyVault(vaultType: Type<@FlowToken.Vault>())
        let registry <- JanusFT.createRegistry(vault: <- emptyVault)
        signer.storage.save(<- registry, to: JanusFT.CommitmentRegistryStoragePath)
        let cap = signer.capabilities.storage.issue<&{JanusFT.CommitmentRegistryPublic}>(
            JanusFT.CommitmentRegistryStoragePath
        )
        signer.capabilities.publish(cap, at: JanusFT.CommitmentRegistryPublicPath)
    }
}
`;

/**
 * Wrap an FT amount into a JanusFT commitment.
 *
 * Args:
 *   registryAddr:     Address holding the JanusFT registry (must == signer for v0.4)
 *   amount:           UFix64 cleartext (boundary leak by design)
 *   txCommitX/Y:      UInt256 Pedersen commit coords
 *   amountProofBytes: [UInt8] opaque proof (v0.4 stub: length>0 check only)
 */
export const TX_FT_WRAP = `import JanusFT from 0xbef3c77681c15397
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(registryAddr: Address, amount: UFix64, txCommitX: UInt256, txCommitY: UInt256, amountProofBytes: [UInt8]) {
    let depositVault: @{FungibleToken.Vault}
    let registryRef: &JanusFT.CommitmentRegistry
    let senderAddress: Address

    prepare(signer: auth(BorrowValue) &Account) {
        self.senderAddress = signer.address
        let userVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("Signer has no FlowToken vault")
        self.depositVault <- userVault.withdraw(amount: amount)
        self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
        ) ?? panic("Signer must hold the JanusFT registry (spike: registry on signer's account)")
    }

    execute {
        self.registryRef.wrap(
            account: self.senderAddress,
            amount: amount,
            depositVault: <- self.depositVault,
            txCommit: JanusFT.Commitment(x: txCommitX, y: txCommitY),
            amountProofBytes: amountProofBytes,
        )
    }
}
`;

/**
 * Shielded transfer of a HIDDEN amount from signer to toAccount.
 *
 * PRIVACY-CRITICAL: this transaction takes NO cleartext amount. Only commitment
 * coords and an opaque proof bytes blob — all amount info is hidden behind
 * Pedersen + Groth16 (Groth16 verification is stubbed in v0.4; arrives in v0.5).
 *
 * Args:
 *   toAccount:       Address of the recipient (visible — account-based model)
 *   publicInputs:    [UInt256; 6] — [C_old.x, C_old.y, C_tx.x, C_tx.y, C_new.x, C_new.y]
 *   proofBytes:      [UInt8] opaque proof
 */
export const TX_FT_SHIELDED_TRANSFER = `import JanusFT from 0xbef3c77681c15397

transaction(toAccount: Address, publicInputs: [UInt256; 6], proofBytes: [UInt8]) {
    let registryRef: &JanusFT.CommitmentRegistry
    let senderAddress: Address

    prepare(signer: auth(BorrowValue) &Account) {
        self.senderAddress = signer.address
        self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
        ) ?? panic("Signer must hold the JanusFT registry (spike model)")
    }

    execute {
        self.registryRef.shieldedTransfer(
            fromAccount: self.senderAddress,
            toAccount: toAccount,
            publicInputs: publicInputs,
            proofBytes: proofBytes,
        )
    }
}
`;

/**
 * Unwrap `claimedAmount` FT back to a recipient.
 *
 * LEAK BY DESIGN: claimedAmount is a cleartext UFix64 arg (boundary).
 *
 * Args:
 *   claimedAmount:           UFix64 cleartext
 *   recipient:               Address that receives the FT vault (must have a
 *                            FungibleToken.Receiver at /public/flowTokenReceiver)
 *   txCommitX/Y:             Pedersen(claimedAmount, blinding) coords
 *   amountProofBytes:        amount_disclose proof (opaque v0.4)
 *   transferPublicInputs:    [C_old, C_tx, C_new] — must include txCommit at [2..3]
 *   transferProofBytes:      ConfidentialTransfer proof (opaque v0.4)
 *
 * NOTE: in v0.4 unwrap is structurally broken on the stub-crypto side
 * (deterministic overflow during totalSupplyCommitment debit). Unblocks in
 * v0.5 once stub BabyJub helpers are replaced with cross-VM calls.
 */
export const TX_FT_UNWRAP = `import JanusFT from 0xbef3c77681c15397
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

transaction(
    claimedAmount: UFix64,
    recipient: Address,
    txCommitX: UInt256, txCommitY: UInt256,
    amountProofBytes: [UInt8],
    transferPublicInputs: [UInt256; 6],
    transferProofBytes: [UInt8]
) {
    let registryRef: &JanusFT.CommitmentRegistry
    let senderAddress: Address

    prepare(signer: auth(BorrowValue) &Account) {
        self.senderAddress = signer.address
        self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
        ) ?? panic("Signer must hold the JanusFT registry (spike model)")
    }

    execute {
        let withdrawn <- self.registryRef.unwrap(
            account: self.senderAddress,
            claimedAmount: claimedAmount,
            recipient: recipient,
            txCommit: JanusFT.Commitment(x: txCommitX, y: txCommitY),
            amountProofBytes: amountProofBytes,
            transferPublicInputs: transferPublicInputs,
            transferProofBytes: transferProofBytes,
        )
        let recipientReceiver = getAccount(recipient)
            .capabilities
            .borrow<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)
            ?? panic("Recipient has no FlowToken receiver")
        recipientReceiver.deposit(from: <- withdrawn)
    }
}
`;

// ---------------------------------------------------------------------------
// Cadence read scripts
// ---------------------------------------------------------------------------

export const SCRIPT_FT_GET_TOTAL_LOCKED = `import JanusFT from 0xbef3c77681c15397

access(all) fun main(): UFix64 {
    return JanusFT.getTotalLocked()
}
`;

export const SCRIPT_FT_GET_COMMITMENT = `import JanusFT from 0xbef3c77681c15397

access(all) fun main(account: Address): {String: UInt256} {
    let c = JanusFT.balanceOfCommitment(account: account)
    return { "x": c.x, "y": c.y }
}
`;

export const SCRIPT_FT_GET_UNDERLYING_TYPE = `import JanusFT from 0xbef3c77681c15397

access(all) fun main(): String {
    return JanusFT.getUnderlyingVaultTypeIdentifier()
}
`;

/**
 * Re-target one of the canonical tx/script templates to a different JanusFT
 * deployment address (e.g. mainnet, or the smoke-mirror). Returns a NEW
 * string — does NOT mutate the original.
 *
 * @param template  One of TX_FT_* / SCRIPT_FT_*
 * @param targetAddr  Hex Cadence address WITH or WITHOUT 0x prefix.
 */
export function buildJanusFTTx(template: string, targetAddr: string): string {
  const addr = targetAddr.startsWith("0x") ? targetAddr : `0x${targetAddr}`;
  // Replace only the canonical "0xbef3c77681c15397" address; other addresses
  // (FlowToken / FungibleToken contract addresses) stay untouched.
  return template.replace(/0xbef3c77681c15397/g, addr.toLowerCase());
}

// ---------------------------------------------------------------------------
// JanusFTCadence — read-only FCL helper (mirrors JanusFlowCadence pattern)
// ---------------------------------------------------------------------------

export interface JanusFTCadenceOptions {
  network: FlowNetwork;
  /** Override the canonical address (e.g. point at smoke mirror or mainnet). */
  contractAddress?: string;
}

export class JanusFTCadence {
  private readonly network: FlowNetwork;
  private readonly contractAddress: string;

  constructor(opts: JanusFTCadenceOptions = { network: "testnet" }) {
    this.network = opts.network;
    this.contractAddress = opts.contractAddress ?? JANUS_FT_CADENCE_ADDRESS;
  }

  /** Configure FCL access node for this network. Call once at app boot. */
  async configure(): Promise<this> {
    const fcl = await import("@onflow/fcl");
    const { NETWORK_CONFIG } = await import("../network/flow-client.js");
    const config = NETWORK_CONFIG[this.network];
    fcl.config({ "accessNode.api": config.flowAccessApi });
    return this;
  }

  /** Read the cleartext totalLocked aggregate. */
  async getTotalLocked(): Promise<string> {
    const fcl = await import("@onflow/fcl");
    const script = buildJanusFTTx(SCRIPT_FT_GET_TOTAL_LOCKED, this.contractAddress);
    return fcl.query({ cadence: script, args: () => [] }) as Promise<string>;
  }

  /** Read an account's Pedersen commitment (returns identity if never written). */
  async balanceOfCommitment(account: string): Promise<{ x: bigint; y: bigint }> {
    const fcl = await import("@onflow/fcl");
    const t = await import("@onflow/types");
    const script = buildJanusFTTx(SCRIPT_FT_GET_COMMITMENT, this.contractAddress);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await fcl.query({
      cadence: script,
      args: (arg: any, types: any) => [arg(account, t.Address)],
    });
    return { x: BigInt(result.x), y: BigInt(result.y) };
  }

  /** Read the underlying FT vault type identifier. */
  async getUnderlyingType(): Promise<string> {
    const fcl = await import("@onflow/fcl");
    const script = buildJanusFTTx(SCRIPT_FT_GET_UNDERLYING_TYPE, this.contractAddress);
    return fcl.query({ cadence: script, args: () => [] }) as Promise<string>;
  }
}
