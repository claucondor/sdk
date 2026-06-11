/**
 * cadence/atomic-transactions.ts — Atomic cross-VM Cadence transaction templates.
 *
 * These templates execute BOTH the Janus EVM action AND ShieldedCheckpoint.update()
 * in a SINGLE Cadence transaction — no second wallet popup, no orphaned checkpoint.
 *
 * Moved from PrivateTip frontend (private-tip-v1/web/lib/cadence-tx.ts) into the SDK
 * so downstream apps reference the SDK constant for the checkpoint address and get
 * the per-token API automatically.
 *
 * v0.8.2 changes vs. v0.8.1 frontend templates:
 *   - ShieldedCheckpoint.update() now takes `address token` as first arg.
 *   - All templates pass `tokenAddrHex` (JS function argument) as the baked-in token address.
 *   - EVM.EVMBytes(value: ...) wrapper applied to all [UInt8] → bytes calldata encodings.
 *   - Checkpoint contract address baked from SDK constant (auto-updates when SDK is bumped).
 *
 * v0.8.2 audit additions:
 *   - wrapErc20Atomic / sendTipErc20Atomic / unwrapErc20Atomic — EVM-side ops for ERC20 tokens
 *   - wrapFtAtomic / sendTipFtAtomic / unwrapFtAtomic / claimBatchFtAtomic — Cadence-side ops
 *     for cadence-ft tokens (JanusFT registry) + EVM checkpoint in one tx
 *
 * Usage:
 *   import { cadenceTx } from '@claucondor/sdk/cadence';
 *   const tx = cadenceTx.wrapFlowAtomic(TOKEN_REGISTRY.flow.proxy);
 *   await fcl.mutate({ cadence: tx, args: ... });
 */

import {
  SHIELDED_CHECKPOINT_ADDRESS,
  SHIELDED_INBOX_ADDRESS,
} from "../network/contracts";

// EVM system contract address on Flow testnet (stable — not configurable)
const EVM_SYSTEM_CONTRACT = "0x8c5303eaa26202d6";

// ---------------------------------------------------------------------------
// updateCheckpointViaCoa
//
// Call EVM ShieldedCheckpoint.update(address token, bytes, ...) via COA.
// Standalone template — use when you only need to persist the checkpoint
// without executing another EVM action in the same tx.
//
// Arguments (FCL):
//   tokenAddrHex:          String  — EVM proxy address of the Janus token (with 0x)
//   encryptedSnapshotHex:  String  — hex-encoded ciphertext (no 0x prefix)
//   ephPubkeyX:            UInt256
//   ephPubkeyY:            UInt256
//   lastConsumedNoteIndex: UInt64
// ---------------------------------------------------------------------------

export function updateCheckpointViaCoa(
  checkpointAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import EVM from ${EVM_SYSTEM_CONTRACT}

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
    let cpAddr = EVM.addressFromString("${checkpointAddr}")
    let tokenAddr = EVM.addressFromString(tokenAddrHex)

    let calldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [tokenAddr, EVM.EVMBytes(value: encryptedSnapshotHex.decodeHex()), ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )

    let result = self.coa.call(
      to:       cpAddr,
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
// wrapFlowAtomic
//
// Atomic wrap for native FLOW: moves FLOW from Cadence vault to COA, calls
// JanusFlow.wrapWithProof via pre-encoded hex calldata, then calls
// ShieldedCheckpoint.update — all in a single FCL transaction.
//
// @param tokenAddrHex  EVM proxy address of the Janus token (e.g. JanusFlow proxy).
//                      Used as the `token` arg for ShieldedCheckpoint.update().
//                      Must match the token proxy used in the wrap call.
//
// Arguments (FCL):
//   amountUFix64:         UFix64  — gross FLOW amount (e.g. "1.00000000")
//   attoflowWei:          UInt    — same amount in attoflow (wei)
//   wrapCalldataHex:      String  — ABI-encoded wrapWithProof calldata, no 0x prefix
//   encryptedSnapshotHex: String  — hex-encoded checkpoint ciphertext
//   ephPubkeyX:           UInt256
//   ephPubkeyY:           UInt256
//   lastConsumedNoteIndex UInt64
// ---------------------------------------------------------------------------

export function wrapFlowAtomic(
  tokenAddrHex: string,
  checkpointAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  amountUFix64: UFix64,
  attoflowWei: UInt,
  wrapCalldataHex: String,
  encryptedSnapshotHex: String,
  ephPubkeyX: UInt256,
  ephPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  prepare(signer: auth(BorrowValue, Storage) &Account) {
    let coa = signer.storage.borrow<auth(EVM.Call, EVM.Owner) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("wrap_flow_atomic: no COA at /storage/evm — run setup_coa first")

    let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
      from: /storage/flowTokenVault
    ) ?? panic("wrap_flow_atomic: no FlowToken vault")

    // Move FLOW from Cadence vault to COA EVM balance
    let payment <- flowVault.withdraw(amount: amountUFix64) as! @FlowToken.Vault
    coa.deposit(from: <-payment)

    // Call JanusFlow.wrapWithProof via pre-encoded calldata
    let wrapResult = coa.call(
      to: EVM.addressFromString("${tokenAddrHex}"),
      data: wrapCalldataHex.decodeHex(),
      gasLimit: 800000,
      value: EVM.Balance(attoflow: attoflowWei)
    )
    assert(
      wrapResult.status == EVM.Status.successful,
      message: "JanusFlow.wrapWithProof reverted: ".concat(wrapResult.errorMessage)
    )

    // Update ShieldedCheckpoint atomically (no second wallet popup)
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [EVM.addressFromString("${tokenAddrHex}"), EVM.EVMBytes(value: encryptedSnapshotHex.decodeHex()), ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = coa.call(
      to: EVM.addressFromString("${checkpointAddr}"),
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// sendTipAtomic
//
// Atomic shielded transfer: JanusToken.shieldedTransfer (via pre-encoded hex calldata)
// + ShieldedCheckpoint.update in a single FCL transaction.
//
// The JanusFlow proxy is passed as a Cadence tx arg (janusProxyHex) to support
// both JanusFlow and JanusERC20 from a single template.
// The checkpoint token address is baked in from `tokenAddrHex` (JS arg) — must
// match the `janusProxyHex` arg passed at runtime.
//
// @param tokenAddrHex  EVM proxy address of the Janus token, baked into checkpoint call.
//
// Arguments (FCL):
//   transferCalldataHex:  String  — ABI-encoded shieldedTransfer calldata, no 0x prefix
//   janusProxyHex:        String  — JanusFlow/JanusERC20 proxy address (with 0x)
//   encryptedSnapshotHex: String  — sender's residual checkpoint ciphertext
//   ephPubkeyX:           UInt256
//   ephPubkeyY:           UInt256
//   lastConsumedNoteIndex UInt64
// ---------------------------------------------------------------------------

export function sendTipAtomic(
  tokenAddrHex: string,
  checkpointAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  transferCalldataHex: String,
  janusProxyHex: String,
  encryptedSnapshotHex: String,
  ephPubkeyX: UInt256,
  ephPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("send_tip_atomic: no COA at /storage/evm")
  }

  execute {
    // 1. JanusToken.shieldedTransfer via pre-encoded calldata
    let janusAddr = EVM.addressFromString(janusProxyHex)
    let transferResult = self.coa.call(
      to: janusAddr,
      data: transferCalldataHex.decodeHex(),
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      transferResult.status == EVM.Status.successful,
      message: "JanusToken.shieldedTransfer reverted: ".concat(transferResult.errorMessage)
    )

    // 2. ShieldedCheckpoint.update (atomic — same tx as transfer)
    // token is baked in from SDK constant (${tokenAddrHex})
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [EVM.addressFromString("${tokenAddrHex}"), EVM.EVMBytes(value: encryptedSnapshotHex.decodeHex()), ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: EVM.addressFromString("${checkpointAddr}"),
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// unwrapFlowAtomic
//
// Atomic unwrap for native FLOW: JanusFlow.unwrap (via pre-encoded hex calldata)
// + ShieldedCheckpoint.update in a single FCL transaction.
//
// @param tokenAddrHex  EVM proxy address of the Janus token (JanusFlow proxy for FLOW).
//
// Arguments (FCL):
//   unwrapCalldataHex:    String  — ABI-encoded unwrap calldata, no 0x prefix
//   encryptedSnapshotHex: String  — residual checkpoint ciphertext
//   ephPubkeyX:           UInt256
//   ephPubkeyY:           UInt256
//   lastConsumedNoteIndex UInt64
// ---------------------------------------------------------------------------

export function unwrapFlowAtomic(
  tokenAddrHex: string,
  checkpointAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  unwrapCalldataHex: String,
  encryptedSnapshotHex: String,
  ephPubkeyX: UInt256,
  ephPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("unwrap_flow_atomic: no COA at /storage/evm")
  }

  execute {
    // 1. JanusFlow.unwrap via pre-encoded calldata
    let janusAddr = EVM.addressFromString("${tokenAddrHex}")
    let unwrapResult = self.coa.call(
      to: janusAddr,
      data: unwrapCalldataHex.decodeHex(),
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      unwrapResult.status == EVM.Status.successful,
      message: "JanusFlow.unwrap reverted: ".concat(unwrapResult.errorMessage)
    )

    // 2. ShieldedCheckpoint.update (atomic — same tx as unwrap)
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [EVM.addressFromString("${tokenAddrHex}"), EVM.EVMBytes(value: encryptedSnapshotHex.decodeHex()), ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: EVM.addressFromString("${checkpointAddr}"),
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// claimBatchAtomic
//
// Atomic batch-claim: drainAll (non-fatal) + JanusToken.claimBatch +
// ShieldedCheckpoint.update in a single FCL transaction.
// Replaces the 3-sequential-tx pattern for inbox draining.
//
// @param tokenAddrHex  EVM proxy address of the Janus token.
//
// Arguments (FCL):
//   publicInputs:         [UInt256] — claimBatch public inputs (6 elements)
//   proof:                [UInt256] — claimBatch proof (8 elements)
//   encryptedSnapshotHex: String    — new consolidated checkpoint ciphertext
//   ephPubkeyX:           UInt256
//   ephPubkeyY:           UInt256
//   lastConsumedNoteIndex UInt64
// ---------------------------------------------------------------------------

export function claimBatchAtomic(
  tokenAddrHex: string,
  checkpointAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  publicInputs: [UInt256],
  proof: [UInt256],
  encryptedSnapshotHex: String,
  ephPubkeyX: UInt256,
  ephPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("claim_batch_atomic: no COA at /storage/evm — activate first")
  }

  execute {
    // 1. drainAll from ShieldedInbox (non-fatal — inbox may already be empty)
    let inboxAddr = EVM.addressFromString("${SHIELDED_INBOX_ADDRESS}")
    let drainCalldata = EVM.encodeABIWithSignature("drainAll()", [])
    let _ = self.coa.call(
      to: inboxAddr,
      data: drainCalldata,
      gasLimit: 400000,
      value: EVM.Balance(attoflow: 0)
    )

    // 2. JanusToken.claimBatch (assert success)
    let janusAddr = EVM.addressFromString("${tokenAddrHex}")
    let claimCalldata = EVM.encodeABIWithSignature(
      "claimBatch(uint256[6],uint256[8])",
      [publicInputs, proof]
    )
    let claimResult = self.coa.call(
      to: janusAddr,
      data: claimCalldata,
      gasLimit: 600000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      claimResult.status == EVM.Status.successful,
      message: "JanusToken.claimBatch failed: ".concat(claimResult.errorMessage)
    )

    // 3. ShieldedCheckpoint.update (assert success)
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [EVM.addressFromString("${tokenAddrHex}"), EVM.EVMBytes(value: encryptedSnapshotHex.decodeHex()), ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: EVM.addressFromString("${checkpointAddr}"),
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// wrapErc20Atomic
//
// Atomic wrap for ERC20 tokens: COA calls ERC20.approve + JanusERC20.wrapWithProof
// (2 EVM calls) + ShieldedCheckpoint.update — all in a single FCL transaction.
//
// @param tokenAddrHex  EVM proxy address of the JanusERC20 token (baked into
//                      checkpoint token arg). Caller must pass matching `proxyHex`
//                      at runtime.
//
// Arguments (FCL):
//   approveCalldataHex:   String  — ABI-encoded ERC20.approve calldata, no 0x prefix
//   wrapCalldataHex:      String  — ABI-encoded wrapWithProof calldata, no 0x prefix
//   underlyingHex:        String  — ERC20 underlying token address (with 0x)
//   proxyHex:             String  — JanusERC20 proxy address (with 0x)
//   encryptedSnapshotHex: String  — hex-encoded checkpoint ciphertext
//   ephPubkeyX:           UInt256
//   ephPubkeyY:           UInt256
//   lastConsumedNoteIndex UInt64
// ---------------------------------------------------------------------------

export function wrapErc20Atomic(
  tokenAddrHex: string,
  checkpointAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  approveCalldataHex: String,
  wrapCalldataHex: String,
  underlyingHex: String,
  proxyHex: String,
  encryptedSnapshotHex: String,
  ephPubkeyX: UInt256,
  ephPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("wrap_erc20_atomic: no COA at /storage/evm — run setup_coa first")
  }

  execute {
    // 1. ERC20.approve(janusProxy, amount) — allow JanusERC20 to pull tokens
    let approveResult = self.coa.call(
      to: EVM.addressFromString(underlyingHex),
      data: approveCalldataHex.decodeHex(),
      gasLimit: 100000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      approveResult.status == EVM.Status.successful,
      message: "ERC20.approve reverted: ".concat(approveResult.errorMessage)
    )

    // 2. JanusERC20.wrapWithProof — shield the tokens
    let wrapResult = self.coa.call(
      to: EVM.addressFromString(proxyHex),
      data: wrapCalldataHex.decodeHex(),
      gasLimit: 800000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      wrapResult.status == EVM.Status.successful,
      message: "JanusERC20.wrapWithProof reverted: ".concat(wrapResult.errorMessage)
    )

    // 3. ShieldedCheckpoint.update — atomic, no second wallet popup
    // token is baked in from SDK constant (${tokenAddrHex})
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [EVM.addressFromString("${tokenAddrHex}"), EVM.EVMBytes(value: encryptedSnapshotHex.decodeHex()), ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: EVM.addressFromString("${checkpointAddr}"),
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// sendTipErc20Atomic
//
// Atomic shielded transfer for ERC20: JanusERC20.shieldedTransfer (via pre-encoded
// hex calldata) + ShieldedCheckpoint.update in a single FCL transaction.
//
// @param tokenAddrHex  EVM proxy address of the JanusERC20 token, baked into both
//                      the shieldedTransfer call and the checkpoint token arg.
//
// Arguments (FCL):
//   transferCalldataHex:  String  — ABI-encoded shieldedTransfer calldata, no 0x prefix
//   encryptedSnapshotHex: String  — sender residual checkpoint ciphertext
//   ephPubkeyX:           UInt256
//   ephPubkeyY:           UInt256
//   lastConsumedNoteIndex UInt64
// ---------------------------------------------------------------------------

export function sendTipErc20Atomic(
  tokenAddrHex: string,
  checkpointAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  transferCalldataHex: String,
  encryptedSnapshotHex: String,
  ephPubkeyX: UInt256,
  ephPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("send_tip_erc20_atomic: no COA at /storage/evm")
  }

  execute {
    // 1. JanusERC20.shieldedTransfer via pre-encoded calldata
    // proxy is baked in from SDK constant (${tokenAddrHex})
    let transferResult = self.coa.call(
      to: EVM.addressFromString("${tokenAddrHex}"),
      data: transferCalldataHex.decodeHex(),
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      transferResult.status == EVM.Status.successful,
      message: "JanusERC20.shieldedTransfer reverted: ".concat(transferResult.errorMessage)
    )

    // 2. ShieldedCheckpoint.update (atomic — same tx as transfer)
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [EVM.addressFromString("${tokenAddrHex}"), EVM.EVMBytes(value: encryptedSnapshotHex.decodeHex()), ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: EVM.addressFromString("${checkpointAddr}"),
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// unwrapErc20Atomic
//
// Atomic unwrap for ERC20: JanusERC20.unwrap (via pre-encoded hex calldata) +
// ShieldedCheckpoint.update in a single FCL transaction.
//
// @param tokenAddrHex  EVM proxy address of the JanusERC20 token, baked into both
//                      the unwrap call and the checkpoint token arg.
//
// Arguments (FCL):
//   unwrapCalldataHex:    String  — ABI-encoded unwrap calldata, no 0x prefix
//   encryptedSnapshotHex: String  — residual checkpoint ciphertext
//   ephPubkeyX:           UInt256
//   ephPubkeyY:           UInt256
//   lastConsumedNoteIndex UInt64
// ---------------------------------------------------------------------------

export function unwrapErc20Atomic(
  tokenAddrHex: string,
  checkpointAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  unwrapCalldataHex: String,
  encryptedSnapshotHex: String,
  ephPubkeyX: UInt256,
  ephPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("unwrap_erc20_atomic: no COA at /storage/evm")
  }

  execute {
    // 1. JanusERC20.unwrap via pre-encoded calldata
    // proxy is baked in from SDK constant (${tokenAddrHex})
    let unwrapResult = self.coa.call(
      to: EVM.addressFromString("${tokenAddrHex}"),
      data: unwrapCalldataHex.decodeHex(),
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      unwrapResult.status == EVM.Status.successful,
      message: "JanusERC20.unwrap reverted: ".concat(unwrapResult.errorMessage)
    )

    // 2. ShieldedCheckpoint.update (atomic — same tx as unwrap)
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [EVM.addressFromString("${tokenAddrHex}"), EVM.EVMBytes(value: encryptedSnapshotHex.decodeHex()), ephPubkeyX, ephPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: EVM.addressFromString("${checkpointAddr}"),
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// wrapFtAtomic
//
// Atomic wrap for Cadence FT tokens (JanusFT): JanusFT.CommitmentRegistry.wrapWithProof
// + ShieldedCheckpoint.update (via COA) in a single FCL transaction.
//
// @param tokenAddrHex   EVM address used as checkpoint token identifier.
//                       For FT tokens with no EVM proxy, use the Cadence deployer
//                       address zero-padded to 20 bytes, e.g.
//                       "0x0000000000000000000000004b6bc58bc8bf5dcc".
// @param contractAddr   Cadence address of the JanusFT contract (e.g. "0x4b6bc58bc8bf5dcc")
// @param ftContractName Name of the FT contract (e.g. "MockFT")
// @param ftAddress      Cadence address of the FT contract
//
// Arguments (FCL):
//   registryAddr:            Address
//   grossAmount:             UFix64
//   nonce:                   UInt256
//   commitX, commitY:        UInt256
//   pA:                      [UInt256]
//   pB:                      [[UInt256]]
//   pC:                      [UInt256]
//   encryptedSnapshot:       [UInt8]  — note encryption for JanusFT.wrapWithProof
//   ephPubkeyX, ephPubkeyY:  UInt256  — ephemeral pubkey for note encryption
//   cpEncryptedSnapshotHex:  String   — hex-encoded checkpoint ciphertext (sender balance)
//   cpEphPubkeyX:            UInt256  — ephemeral pubkey for checkpoint
//   cpEphPubkeyY:            UInt256
//   lastConsumedNoteIndex:   UInt64
// ---------------------------------------------------------------------------

export function wrapFtAtomic(
  tokenAddrHex: string,
  contractAddr: string,
  ftContractName: string,
  ftAddress: string,
  checkpointAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import JanusFT from ${contractAddr}
import ${ftContractName} from ${ftAddress}
import FungibleToken from 0x9a0766d93b6608b7
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  registryAddr: Address,
  grossAmount: UFix64,
  nonce: UInt256,
  commitX: UInt256, commitY: UInt256,
  pA: [UInt256],
  pB: [[UInt256]],
  pC: [UInt256],
  encryptedSnapshot: [UInt8],
  ephPubkeyX: UInt256, ephPubkeyY: UInt256,
  cpEncryptedSnapshotHex: String,
  cpEphPubkeyX: UInt256,
  cpEphPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let depositVault: @{FungibleToken.Vault}
  let registryRef: &JanusFT.CommitmentRegistry
  let senderAddress: Address
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.senderAddress = signer.address

    let userVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &${ftContractName}.Vault>(
      from: ${ftContractName}.VaultStoragePath
    ) ?? panic("wrap_ft_atomic: signer has no ${ftContractName} vault")
    self.depositVault <- userVault.withdraw(amount: grossAmount)

    self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
      from: JanusFT.CommitmentRegistryStoragePath
    ) ?? panic("wrap_ft_atomic: signer must hold the JanusFT registry")

    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("wrap_ft_atomic: no COA at /storage/evm — run setup_coa first")
  }

  execute {
    // 1. JanusFT.wrapWithProof — shield the Cadence FT tokens
    self.registryRef.wrapWithProof(
      account:           self.senderAddress,
      nonce:             nonce,
      commitX:           commitX,
      commitY:           commitY,
      pA:                pA,
      pB:                pB,
      pC:                pC,
      encryptedSnapshot: encryptedSnapshot,
      ephPubkeyX:        ephPubkeyX,
      ephPubkeyY:        ephPubkeyY,
      vault:             <- self.depositVault,
      coa:               self.coa
    )

    // 2. ShieldedCheckpoint.update — atomic, no second wallet popup
    // token identifier baked from SDK constant (${tokenAddrHex})
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [EVM.addressFromString("${tokenAddrHex}"), EVM.EVMBytes(value: cpEncryptedSnapshotHex.decodeHex()), cpEphPubkeyX, cpEphPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: EVM.addressFromString("${checkpointAddr}"),
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// sendTipFtAtomic
//
// Atomic shielded transfer for Cadence FT: JanusFT.CommitmentRegistry.shieldedTransfer
// + ShieldedCheckpoint.update (via COA) in a single FCL transaction.
//
// @param tokenAddrHex  EVM address used as checkpoint token identifier.
// @param contractAddr  Cadence address of the JanusFT contract.
//
// Arguments (FCL):
//   fromAccount:           Address
//   toAccount:             Address
//   transferProof:         [UInt256]
//   publicInputs:          [UInt256]
//   encryptedNoteTo:       [UInt8]
//   ephPubToX:             UInt256
//   ephPubToY:             UInt256
//   cpEncryptedSnapshotHex: String  — hex-encoded checkpoint ciphertext (sender residual)
//   cpEphPubkeyX:          UInt256
//   cpEphPubkeyY:          UInt256
//   lastConsumedNoteIndex: UInt64
// ---------------------------------------------------------------------------

export function sendTipFtAtomic(
  tokenAddrHex: string,
  contractAddr: string,
  checkpointAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import JanusFT from ${contractAddr}
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  fromAccount: Address,
  toAccount: Address,
  transferProof: [UInt256],
  publicInputs: [UInt256],
  encryptedNoteTo: [UInt8], ephPubToX: UInt256, ephPubToY: UInt256,
  cpEncryptedSnapshotHex: String,
  cpEphPubkeyX: UInt256,
  cpEphPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let registryRef: &JanusFT.CommitmentRegistry
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
      from: JanusFT.CommitmentRegistryStoragePath
    ) ?? panic("send_tip_ft_atomic: signer must hold the JanusFT registry")
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("send_tip_ft_atomic: no COA at /storage/evm")
  }

  execute {
    // 1. JanusFT.shieldedTransfer — Cadence-side privacy transfer
    self.registryRef.shieldedTransfer(
      fromAccount:     fromAccount,
      toAccount:       toAccount,
      transferProof:   transferProof,
      publicInputs:    publicInputs,
      encryptedNoteTo: encryptedNoteTo,
      ephPubToX:       ephPubToX,
      ephPubToY:       ephPubToY,
      coa:             self.coa
    )

    // 2. ShieldedCheckpoint.update — atomic, no second wallet popup
    // token identifier baked from SDK constant (${tokenAddrHex})
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [EVM.addressFromString("${tokenAddrHex}"), EVM.EVMBytes(value: cpEncryptedSnapshotHex.decodeHex()), cpEphPubkeyX, cpEphPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: EVM.addressFromString("${checkpointAddr}"),
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// unwrapFtAtomic
//
// Atomic unwrap for Cadence FT: JanusFT.CommitmentRegistry.unwrap +
// ShieldedCheckpoint.update (via COA) in a single FCL transaction.
//
// @param tokenAddrHex   EVM address used as checkpoint token identifier.
// @param contractAddr   Cadence address of the JanusFT contract.
// @param ftContractName Name of the FT contract (e.g. "MockFT")
// @param ftAddress      Cadence address of the FT contract
//
// Arguments (FCL):
//   account:                Address
//   claimedAmount:          UFix64
//   recipient:              Address
//   txCommitX, txCommitY:   UInt256
//   amountProof:            [UInt256]
//   amountPublicInputs:     [UInt256]
//   transferProof:          [UInt256]
//   transferPublicInputs:   [UInt256]
//   encryptedSnapshot:      [UInt8]  — snapshot arg for JanusFT.unwrap
//   ephPubX, ephPubY:       UInt256  — ephemeral pubkey for JanusFT.unwrap
//   cpEncryptedSnapshotHex: String   — hex-encoded checkpoint ciphertext (residual)
//   cpEphPubkeyX:           UInt256
//   cpEphPubkeyY:           UInt256
//   lastConsumedNoteIndex:  UInt64
// ---------------------------------------------------------------------------

export function unwrapFtAtomic(
  tokenAddrHex: string,
  contractAddr: string,
  ftContractName: string,
  ftAddress: string,
  checkpointAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import JanusFT from ${contractAddr}
import ${ftContractName} from ${ftAddress}
import FungibleToken from 0x9a0766d93b6608b7
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  account: Address,
  claimedAmount: UFix64,
  recipient: Address,
  txCommitX: UInt256, txCommitY: UInt256,
  amountProof: [UInt256],
  amountPublicInputs: [UInt256],
  transferProof: [UInt256],
  transferPublicInputs: [UInt256],
  encryptedSnapshot: [UInt8], ephPubX: UInt256, ephPubY: UInt256,
  cpEncryptedSnapshotHex: String,
  cpEphPubkeyX: UInt256,
  cpEphPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let registryRef: &JanusFT.CommitmentRegistry
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
  let recipientRef: &{FungibleToken.Receiver}

  prepare(signer: auth(BorrowValue) &Account) {
    self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
      from: JanusFT.CommitmentRegistryStoragePath
    ) ?? panic("unwrap_ft_atomic: signer must hold the JanusFT registry")
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("unwrap_ft_atomic: no COA at /storage/evm")
    self.recipientRef = getAccount(recipient)
      .capabilities.borrow<&{FungibleToken.Receiver}>(${ftContractName}.ReceiverPublicPath)
      ?? panic("unwrap_ft_atomic: recipient has no ${ftContractName} receiver")
  }

  execute {
    // 1. JanusFT.unwrap — Cadence-side, releases tokens to recipient
    let netVault <- self.registryRef.unwrap(
      account:             account,
      claimedAmount:       claimedAmount,
      recipient:           recipient,
      txCommit:            JanusFT.Commitment(x: txCommitX, y: txCommitY),
      amountProof:         amountProof,
      amountPublicInputs:  amountPublicInputs,
      transferProof:       transferProof,
      transferPublicInputs: transferPublicInputs,
      encryptedSnapshot:   encryptedSnapshot,
      ephPubX:             ephPubX,
      ephPubY:             ephPubY,
      coa:                 self.coa
    )
    self.recipientRef.deposit(from: <- netVault)

    // 2. ShieldedCheckpoint.update — atomic, no second wallet popup
    // token identifier baked from SDK constant (${tokenAddrHex})
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [EVM.addressFromString("${tokenAddrHex}"), EVM.EVMBytes(value: cpEncryptedSnapshotHex.decodeHex()), cpEphPubkeyX, cpEphPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: EVM.addressFromString("${checkpointAddr}"),
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// claimBatchFtAtomic
//
// Atomic batch-claim for Cadence FT: JanusFT.CommitmentRegistry.claimBatch +
// ShieldedCheckpoint.update (via COA) in a single FCL transaction.
//
// @param tokenAddrHex  EVM address used as checkpoint token identifier.
// @param contractAddr  Cadence address of the JanusFT contract.
//
// Arguments (FCL):
//   account:               Address
//   publicInputs:          [UInt256]
//   proof:                 [UInt256]
//   cpEncryptedSnapshotHex: String  — hex-encoded checkpoint ciphertext (consolidated)
//   cpEphPubkeyX:          UInt256
//   cpEphPubkeyY:          UInt256
//   lastConsumedNoteIndex: UInt64
// ---------------------------------------------------------------------------

export function claimBatchFtAtomic(
  tokenAddrHex: string,
  contractAddr: string,
  checkpointAddr = SHIELDED_CHECKPOINT_ADDRESS,
): string {
  return `
import JanusFT from ${contractAddr}
import EVM from ${EVM_SYSTEM_CONTRACT}

transaction(
  account: Address,
  publicInputs: [UInt256],
  proof: [UInt256],
  cpEncryptedSnapshotHex: String,
  cpEphPubkeyX: UInt256,
  cpEphPubkeyY: UInt256,
  lastConsumedNoteIndex: UInt64
) {
  let registryRef: &JanusFT.CommitmentRegistry
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
      from: JanusFT.CommitmentRegistryStoragePath
    ) ?? panic("claim_batch_ft_atomic: signer must hold the JanusFT registry")
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("claim_batch_ft_atomic: no COA at /storage/evm")
  }

  execute {
    // 1. JanusFT.claimBatch — aggregate inbox notes into commitment
    self.registryRef.claimBatch(
      account:      account,
      publicInputs: publicInputs,
      proof:        proof,
      coa:          self.coa
    )

    // 2. ShieldedCheckpoint.update — atomic, no second wallet popup
    // token identifier baked from SDK constant (${tokenAddrHex})
    let cpCalldata = EVM.encodeABIWithSignature(
      "update(address,bytes,uint256,uint256,uint64)",
      [EVM.addressFromString("${tokenAddrHex}"), EVM.EVMBytes(value: cpEncryptedSnapshotHex.decodeHex()), cpEphPubkeyX, cpEphPubkeyY, lastConsumedNoteIndex]
    )
    let cpResult = self.coa.call(
      to: EVM.addressFromString("${checkpointAddr}"),
      data: cpCalldata,
      gasLimit: 1500000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      cpResult.status == EVM.Status.successful,
      message: "ShieldedCheckpoint.update failed: ".concat(cpResult.errorMessage)
    )
  }
}
`;
}

