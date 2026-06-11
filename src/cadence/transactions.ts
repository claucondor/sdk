/**
 * cadence/transactions.ts — Cadence transaction templates for ShieldedInbox,
 * ShieldedCheckpoint, and combined inbox+checkpoint operations (v0.8).
 *
 * Usage:
 *   import { cadenceTx } from '@claucondor/sdk/cadence';
 *   const txCode = cadenceTx.installInbox();
 *   const txId = await fcl.mutate({ cadence: txCode, args: () => [], ... });
 *
 * Address convention:
 *   - All Janus Cadence contracts at CADENCE_DEPLOYER_ADDRESS = 0x4b6bc58bc8bf5dcc
 *   - EVM contracts (ShieldedCheckpoint, JanusFlow) are hardcoded inside template strings
 *     as hex addresses passed to EVM.addressFromString()
 *   - FungibleToken at 0x9a0766d93b6608b7 (testnet standard)
 *   - EVM at 0x8c5303eaa26202d6 (testnet standard)
 *
 * All transactions are idempotent where applicable (install-* check before creating).
 * All COA-call transactions assert successful EVM status and revert on failure.
 */

import {
  CADENCE_DEPLOYER_ADDRESS,
  SHIELDED_CHECKPOINT_ADDRESS,
  SHIELDED_INBOX_ADDRESS,
} from "../network/contracts";

// ---------------------------------------------------------------------------
// install_inbox
//
// Install the Cadence NoteInbox resource + publish &{Receiver} capability.
// Idempotent: no-op if the resource is already installed at the correct type.
// Must be run once before the user's account can receive shielded notes via Cadence.
//
// Arguments: none
// ---------------------------------------------------------------------------

export function installInbox(cadenceDeployer = CADENCE_DEPLOYER_ADDRESS): string {
  return `
import ShieldedInbox from ${cadenceDeployer}

transaction {
  prepare(
    signer: auth(
      BorrowValue,
      SaveValue,
      LoadValue,
      IssueStorageCapabilityController,
      PublishCapability,
      UnpublishCapability
    ) &Account
  ) {
    let storagePath = /storage/shieldedInbox
    let publicPath  = /public/shieldedInbox

    let storedType = signer.storage.type(at: storagePath)

    if storedType == Type<@ShieldedInbox.NoteInbox>() {
      // Already installed — ensure capability is published
      signer.capabilities.unpublish(publicPath)
      let cap = signer.capabilities.storage.issue<&{ShieldedInbox.Receiver}>(storagePath)
      signer.capabilities.publish(cap, at: publicPath)
      return
    }

    if storedType != nil {
      let stale <- signer.storage.load<@AnyResource>(from: storagePath)
        ?? panic("install_inbox: stale resource vanished")
      destroy stale
    }

    let inbox <- ShieldedInbox.createInbox(owner: signer.address)
    signer.storage.save(<- inbox, to: storagePath)

    signer.capabilities.unpublish(publicPath)
    let cap = signer.capabilities.storage.issue<&{ShieldedInbox.Receiver}>(storagePath)
    signer.capabilities.publish(cap, at: publicPath)
  }
}
`;
}

// ---------------------------------------------------------------------------
// install_checkpoint
//
// Install the Cadence Checkpoint resource + publish &{Metadata} capability.
// Idempotent: no-op if already installed at the correct type.
// Must be run once before the user can write checkpoints via Cadence.
//
// Arguments: none
// ---------------------------------------------------------------------------

export function installCheckpoint(cadenceDeployer = CADENCE_DEPLOYER_ADDRESS): string {
  return `
import ShieldedCheckpoint from ${cadenceDeployer}

transaction {
  prepare(
    signer: auth(
      BorrowValue,
      SaveValue,
      LoadValue,
      IssueStorageCapabilityController,
      PublishCapability,
      UnpublishCapability
    ) &Account
  ) {
    let storagePath = /storage/shieldedCheckpoint
    let publicPath  = /public/shieldedCheckpoint

    let storedType = signer.storage.type(at: storagePath)

    if storedType == Type<@ShieldedCheckpoint.Checkpoint>() {
      // Already installed — re-publish capability (idempotent)
      signer.capabilities.unpublish(publicPath)
      let cap = signer.capabilities.storage.issue<&{ShieldedCheckpoint.Metadata}>(storagePath)
      signer.capabilities.publish(cap, at: publicPath)
      return
    }

    if storedType != nil {
      let stale <- signer.storage.load<@AnyResource>(from: storagePath)
        ?? panic("install_checkpoint: stale resource vanished")
      destroy stale
    }

    let cp <- ShieldedCheckpoint.createCheckpoint(owner: signer.address)
    signer.storage.save(<- cp, to: storagePath)

    signer.capabilities.unpublish(publicPath)
    let cap = signer.capabilities.storage.issue<&{ShieldedCheckpoint.Metadata}>(storagePath)
    signer.capabilities.publish(cap, at: publicPath)
  }
}
`;
}

// ---------------------------------------------------------------------------
// update_checkpoint_via_coa
//
// Call EVM ShieldedCheckpoint.update(address token, bytes, uint256, uint256, uint64)
// via the signer's COA.
// Used after a shieldedTransfer (EVM path) to persist the sender's new balance.
//
// v0.8.2 BREAKING CHANGE: token address is now the first argument (multi-token support).
// The `tokenAddrHex` argument is a Cadence transaction argument (passed via FCL args),
// so the same template works for any token — no re-compilation needed.
//
// Arguments (FCL):
//   tokenAddrHex:          String  — EVM proxy address of the Janus token (e.g. JanusFlow proxy)
//   encryptedSnapshotHex:  String  — hex-encoded snapshot bytes (no 0x prefix)
//   ephPubkeyX:            UInt256
//   ephPubkeyY:            UInt256
//   lastConsumedNoteIndex: UInt64
// ---------------------------------------------------------------------------

export function updateCheckpointViaCoa(
  checkpointEvmAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import EVM from 0x8c5303eaa26202d6

transaction(
  tokenAddrHex:          String,
  encryptedSnapshotHex:  String,
  ephPubkeyX:            UInt256,
  ephPubkeyY:            UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("update_checkpoint_via_coa: no COA at /storage/evm — run setup_coa first")
  }

  execute {
    let checkpointAddr = EVM.addressFromString("${checkpointEvmAddr}")
    let tokenAddr = EVM.addressFromString(tokenAddrHex)

    let calldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [tokenAddr, EVM.EVMBytes(value: encryptedSnapshotHex.decodeHex()), ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )

    let result = self.coa.call(
      to:       checkpointAddr,
      data:     calldata,
      gasLimit: 1500000,
      value:    EVM.Balance(attoflow: 0)
    )

    assert(
      result.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(result.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// combined_shielded_transfer_with_checkpoint
//
// Atomically execute both:
//   1. JanusFlow (EVM) shieldedTransfer via COA
//   2. ShieldedCheckpoint (EVM) update via COA
//
// This is the preferred single-tx path for JanusFlow users who want atomic
// transfer + checkpoint persistence. Both EVM calls happen inside one Cadence tx.
//
// Arguments (FCL):
//   to:                    EVM.EVMAddress  (recipient EVM address)
//   publicInputs:          [UInt256]       (6 elements: C_old.x,y, C_tx.x,y, C_new.x,y)
//   proof:                 [UInt256]       (8 elements: Groth16 proof)
//   encryptedNoteTo:       [UInt8]         (ECIES ciphertext for recipient)
//   ephPubkeyToX:          UInt256
//   ephPubkeyToY:          UInt256
//   encryptedSnapshot:     [UInt8]         (ECIES ciphertext for sender checkpoint)
//   ephPubkeyX:            UInt256
//   ephPubkeyY:            UInt256
//   lastConsumedNoteIndex: UInt64          (inbox cursor)
// ---------------------------------------------------------------------------

export function combinedShieldedTransferWithCheckpoint(
  janusFlowEvmAddr: string,
  checkpointEvmAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import EVM from 0x8c5303eaa26202d6

transaction(
  to:                    EVM.EVMAddress,
  publicInputs:          [UInt256],
  proof:                 [UInt256],
  encryptedNoteTo:       [UInt8],
  ephPubkeyToX:          UInt256,
  ephPubkeyToY:          UInt256,
  encryptedSnapshot:     [UInt8],
  ephPubkeyX:            UInt256,
  ephPubkeyY:            UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("combined_shielded_transfer_with_checkpoint: no COA at /storage/evm")
  }

  execute {
    // ── Step 1: JanusFlow.shieldedTransfer ─────────────────────────────
    let janusFlowAddr = EVM.addressFromString("${janusFlowEvmAddr}")

    let transferCalldata = EVM.encodeABIWithSignature(
      "shieldedTransfer(address,uint256[6],uint256[8],bytes,uint256,uint256)",
      [to, publicInputs, proof, EVM.EVMBytes(value: encryptedNoteTo), ephPubkeyToX, ephPubkeyToY]
    )

    let transferResult = self.coa.call(
      to:       janusFlowAddr,
      data:     transferCalldata,
      gasLimit: 500000,
      value:    EVM.Balance(attoflow: 0)
    )

    assert(
      transferResult.status == EVM.Status.successful,
      message: "JanusFlow.shieldedTransfer failed: ".concat(transferResult.errorMessage)
    )

    // ── Step 2: ShieldedCheckpoint.update (token = janusFlowAddr) ─────────
    // v0.8.2: token is the first arg — for shieldedTransfer the token IS the JanusFlow proxy.
    let checkpointAddr = EVM.addressFromString("${checkpointEvmAddr}")

    let checkpointCalldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [janusFlowAddr, EVM.EVMBytes(value: encryptedSnapshot), ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )

    let checkpointResult = self.coa.call(
      to:       checkpointAddr,
      data:     checkpointCalldata,
      gasLimit: 1500000,
      value:    EVM.Balance(attoflow: 0)
    )

    assert(
      checkpointResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(checkpointResult.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// install_inbox_and_checkpoint
//
// Composite: install both NoteInbox and Checkpoint resources in a single tx.
// Convenience for first-time setup flows — equivalent to running installInbox()
// then installCheckpoint() sequentially, but saves one tx fee and one round-trip.
//
// Arguments: none
// ---------------------------------------------------------------------------

export function installInboxAndCheckpoint(cadenceDeployer = CADENCE_DEPLOYER_ADDRESS): string {
  return `
import ShieldedInbox from ${cadenceDeployer}
import ShieldedCheckpoint from ${cadenceDeployer}

transaction {
  prepare(
    signer: auth(
      BorrowValue,
      SaveValue,
      LoadValue,
      IssueStorageCapabilityController,
      PublishCapability,
      UnpublishCapability
    ) &Account
  ) {
    // ── NoteInbox ───────────────────────────────────────────────────────
    let inboxStoragePath = /storage/shieldedInbox
    let inboxPublicPath  = /public/shieldedInbox

    let inboxType = signer.storage.type(at: inboxStoragePath)
    if inboxType != Type<@ShieldedInbox.NoteInbox>() {
      if inboxType != nil {
        let stale <- signer.storage.load<@AnyResource>(from: inboxStoragePath)
          ?? panic("install_inbox_and_checkpoint: stale inbox resource vanished")
        destroy stale
      }
      let inbox <- ShieldedInbox.createInbox(owner: signer.address)
      signer.storage.save(<- inbox, to: inboxStoragePath)
    }
    signer.capabilities.unpublish(inboxPublicPath)
    let inboxCap = signer.capabilities.storage.issue<&{ShieldedInbox.Receiver}>(inboxStoragePath)
    signer.capabilities.publish(inboxCap, at: inboxPublicPath)

    // ── Checkpoint ──────────────────────────────────────────────────────
    let cpStoragePath = /storage/shieldedCheckpoint
    let cpPublicPath  = /public/shieldedCheckpoint

    let cpType = signer.storage.type(at: cpStoragePath)
    if cpType != Type<@ShieldedCheckpoint.Checkpoint>() {
      if cpType != nil {
        let stale <- signer.storage.load<@AnyResource>(from: cpStoragePath)
          ?? panic("install_inbox_and_checkpoint: stale checkpoint resource vanished")
        destroy stale
      }
      let cp <- ShieldedCheckpoint.createCheckpoint(owner: signer.address)
      signer.storage.save(<- cp, to: cpStoragePath)
    }
    signer.capabilities.unpublish(cpPublicPath)
    let cpCap = signer.capabilities.storage.issue<&{ShieldedCheckpoint.Metadata}>(cpStoragePath)
    signer.capabilities.publish(cpCap, at: cpPublicPath)
  }
}
`;
}
