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
 * IMPORTANT — MockFT (Cadence FT path) caveat:
 *   The on-chain Cadence ShieldedCheckpoint upgrade was BLOCKED in v0.8.2 sprint A.4.
 *   MockFT shielded balance still writes to the old singleton checkpoint on the Cadence side.
 *   The EVM checkpoint path below uses the new multi-token contract and works correctly for
 *   JanusFlow (native FLOW) and JanusERC20 (mUSDC). For MockFT, the checkpoint call will
 *   succeed on-chain (writes to EVM checkpoint with token = mockFT cadence-formatted addr)
 *   but is SUBJECT TO SINGLETON OVERWRITE on the Cadence side until the Cadence upgrade ships.
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

