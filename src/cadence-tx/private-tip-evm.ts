/**
 * cadence-tx/private-tip-evm.ts — Cadence transaction & script builders for
 * PrivateTip v0.8 EVM-recipient tips.
 *
 * Exports three builders and one script builder:
 *
 *   buildRecordTipWithSnapshotEvmTx
 *     Standalone tx: only calls PrivateTip.recordTipWithSenderSnapshotEVM.
 *     Use when the token transfer happened separately.
 *
 *   buildShieldedTransferPlusRecordTipEvmTx
 *     Combined tx for EVM tokens (FLOW, ERC20): COA calls EVM proxy
 *     shieldedTransfer + PrivateTip.recordTipWithSenderSnapshotEVM atomically.
 *
 *   buildShieldedTransferFTPlusRecordTipEvmTx
 *     Combined tx for Cadence FT tokens (JanusFT/MockFT): calls
 *     JanusFT.shieldedTransfer + PrivateTip.recordTipWithSenderSnapshotEVM atomically.
 *
 *   buildGetShieldedTipsBySenderWithSnapshotEvmScript
 *     Script builder: returns all EVM-recipient tips for a sender.
 *
 * All builders produce { cadence: string, args: FclArg[] } where `args` is
 * compatible with both `flow transactions send --args-json` (CLI) and
 * FCL's `fcl.mutate` args array (front-end).
 */

import { ethers } from "ethers";
import type { ShieldedTransferOrchestrateResult } from "../orchestration/shielded-transfer";

// ABI for EVM Janus proxy shieldedTransfer (ERC20 and native FLOW share the same signature)
const SHIELDED_TRANSFER_ABI = [
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external",
] as const;

// ─── Shared types ─────────────────────────────────────────────────────────────

/**
 * FCL-compatible argument entry.
 * Compatible with `flow transactions send --args-json` format and FCL's
 * mutate/query arg pattern.
 */
export interface FclArg {
  type: string;
  value: string | FclArg[];
}

// ─── buildRecordTipWithSnapshotEvmTx ─────────────────────────────────────────

export interface BuildRecordTipEvmTxArgs {
  /**
   * Cadence address of the deployed PrivateTip contract (with 0x prefix).
   * Example: "0xd32d9100e1fe983b"
   */
  privateTipAddress: string;
  /**
   * 40-char hex WITHOUT 0x prefix — the recipient's COA EVM address.
   * Example: "0000000000000000000000027b94cfc8a64971cd"
   */
  recipientEvmHex: string;
  /** Recipient's encrypted note (encrypted with recipient's memokey). */
  memo: { ciphertext: number[]; ephPubkey: { x: bigint; y: bigint } };
  /** Sender's self-encrypted residual snapshot (encrypted with sender's own memokey). */
  senderSnapshot: { ciphertext: number[]; ephPubkey: { x: bigint; y: bigint } };
}

export interface RecordTipEvmTxResult {
  /** Cadence transaction source code with imports substituted. */
  cadence: string;
  /** Arguments array in FCL / flow-cli --args-json format. */
  args: FclArg[];
}

/**
 * Build a standalone Cadence tx that calls
 * PrivateTip.recordTipWithSenderSnapshotEVM — no token transfer included.
 *
 * @example
 * const { cadence, args } = buildRecordTipWithSnapshotEvmTx({
 *   privateTipAddress: "0xd32d9100e1fe983b",
 *   recipientEvmHex: "0000000000000000000000027b94cfc8a64971cd",
 *   memo: { ciphertext: [...], ephPubkey: { x: ..., y: ... } },
 *   senderSnapshot: { ciphertext: [...], ephPubkey: { x: ..., y: ... } },
 * });
 */
export function buildRecordTipWithSnapshotEvmTx(
  input: BuildRecordTipEvmTxArgs
): RecordTipEvmTxResult {
  const addrHex = input.privateTipAddress.replace(/^0x/, "");
  const recipientEvmHex = input.recipientEvmHex.replace(/^0x/, "");

  const cadence = `import PrivateTip from 0x${addrHex}

transaction(
    recipientEvmHex: String,
    memoCiphertext: [UInt8],
    memoEphPubkeyX: UInt256,
    memoEphPubkeyY: UInt256,
    senderSnapshotCiphertext: [UInt8],
    senderSnapshotEphPubkeyX: UInt256,
    senderSnapshotEphPubkeyY: UInt256
) {
    prepare(signer: auth(BorrowValue) &Account) {
        let tipID = PrivateTip.recordTipWithSenderSnapshotEVM(
            sender: signer,
            recipientEvmHex: recipientEvmHex,
            memoCiphertext: memoCiphertext,
            memoEphPubkeyX: memoEphPubkeyX,
            memoEphPubkeyY: memoEphPubkeyY,
            senderSnapshotCiphertext: senderSnapshotCiphertext,
            senderSnapshotEphPubkeyX: senderSnapshotEphPubkeyX,
            senderSnapshotEphPubkeyY: senderSnapshotEphPubkeyY
        )
        log("tipID=".concat(tipID.toString()))
    }
}`;

  const args: FclArg[] = [
    { type: "String",  value: recipientEvmHex },
    { type: "Array",   value: input.memo.ciphertext.map(b => ({ type: "UInt8", value: b.toString() })) },
    { type: "UInt256", value: input.memo.ephPubkey.x.toString() },
    { type: "UInt256", value: input.memo.ephPubkey.y.toString() },
    { type: "Array",   value: input.senderSnapshot.ciphertext.map(b => ({ type: "UInt8", value: b.toString() })) },
    { type: "UInt256", value: input.senderSnapshot.ephPubkey.x.toString() },
    { type: "UInt256", value: input.senderSnapshot.ephPubkey.y.toString() },
  ];

  return { cadence, args };
}

// ─── buildShieldedTransferPlusRecordTipEvmTx ─────────────────────────────────

export interface BuildShieldedTransferPlusRecordTipEvmTxArgs {
  /**
   * Cadence address of the deployed PrivateTip contract (with 0x prefix).
   * Example: "0xd32d9100e1fe983b"
   */
  privateTipAddress: string;
  /**
   * EVM proxy contract address (with 0x prefix, 42 chars).
   * Example: TOKEN_REGISTRY.mockusdc.proxy
   */
  proxyAddress: string;
  /**
   * Recipient's COA EVM address (with 0x prefix, 42 chars).
   * Example: "0x0000000000000000000000027b94cfc8a64971cd"
   */
  recipientEvmAddress: string;
  /** Result from orchestrateShieldedTransfer. */
  orchResult: ShieldedTransferOrchestrateResult;
}

export interface ShieldedTransferPlusRecordTipEvmTxResult {
  /** Cadence transaction source code. */
  cadence: string;
  /** Arguments array in FCL / flow-cli --args-json format. */
  args: FclArg[];
  /** ABI-encoded EVM calldata (hex, without 0x) for the shieldedTransfer call. */
  evmCalldataHex: string;
}

/**
 * Build a combined Cadence tx that atomically:
 *   1. Calls JanusEVM.shieldedTransfer via the sender's COA (EVM token path).
 *   2. Calls PrivateTip.recordTipWithSenderSnapshotEVM.
 *
 * Suitable for FLOW (native) and ERC20 token variants — any token whose
 * shieldedTransfer lives on an EVM proxy callable via COA.call.
 *
 * @example
 * const { cadence, args } = buildShieldedTransferPlusRecordTipEvmTx({
 *   privateTipAddress: "0xd32d9100e1fe983b",
 *   proxyAddress: TOKEN_REGISTRY.mockusdc.proxy,
 *   recipientEvmAddress: daveCoaEvm,
 *   orchResult,
 * });
 */
export function buildShieldedTransferPlusRecordTipEvmTx(
  input: BuildShieldedTransferPlusRecordTipEvmTxArgs
): ShieldedTransferPlusRecordTipEvmTxResult {
  const { privateTipAddress, proxyAddress, recipientEvmAddress, orchResult } = input;

  const tipAddrHex = privateTipAddress.replace(/^0x/, "");
  const recipientEvmHex = recipientEvmAddress.replace(/^0x/, "");

  if (recipientEvmHex.length !== 40) {
    throw new RangeError(
      `buildShieldedTransferPlusRecordTipEvmTx: recipientEvmAddress must be 42-char 0x-prefixed address, got "${recipientEvmAddress}"`
    );
  }

  // ABI-encode the EVM shieldedTransfer calldata
  const iface = new ethers.Interface(SHIELDED_TRANSFER_ABI);
  const evmCalldataHex = iface.encodeFunctionData("shieldedTransfer", [
    recipientEvmAddress,
    [...orchResult.publicInputs],
    [...orchResult.proof],
    ethers.hexlify(orchResult.encryptedSnapshot),
    orchResult.ephPubkeyX,
    orchResult.ephPubkeyY,
    ethers.hexlify(orchResult.encryptedNoteTo),
    orchResult.ephPubkeyToX,
    orchResult.ephPubkeyToY,
  ]).slice(2); // strip leading 0x — Cadence decodeHex() expects raw hex

  const cadence = `import EVM from 0x8c5303eaa26202d6
import PrivateTip from 0x${tipAddrHex}

transaction(
    proxyHex: String,
    calldataHex: String,
    recipientEvmHex: String,
    memoCiphertext: [UInt8],
    memoEphPubkeyX: UInt256,
    memoEphPubkeyY: UInt256,
    senderSnapshotCiphertext: [UInt8],
    senderSnapshotEphPubkeyX: UInt256,
    senderSnapshotEphPubkeyY: UInt256
) {
    let signerRef: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.signerRef = signer
    }

    execute {
        // 1. Execute EVM shieldedTransfer via COA
        let coa = self.signerRef.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA at /storage/evm")

        let r = coa.call(
            to: EVM.addressFromString(proxyHex),
            data: calldataHex.decodeHex(),
            gasLimit: 3000000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            r.status == EVM.Status.successful,
            message: "shieldedTransfer reverted: "
                .concat(r.errorCode.toString())
                .concat(" ")
                .concat(r.errorMessage)
        )

        // 2. Record EVM-recipient tip with sender snapshot (atomic)
        let tipID = PrivateTip.recordTipWithSenderSnapshotEVM(
            sender: self.signerRef,
            recipientEvmHex: recipientEvmHex,
            memoCiphertext: memoCiphertext,
            memoEphPubkeyX: memoEphPubkeyX,
            memoEphPubkeyY: memoEphPubkeyY,
            senderSnapshotCiphertext: senderSnapshotCiphertext,
            senderSnapshotEphPubkeyX: senderSnapshotEphPubkeyX,
            senderSnapshotEphPubkeyY: senderSnapshotEphPubkeyY
        )
        log("EVM tip tipID=".concat(tipID.toString()))
    }
}`;

  // Args order matches tx parameter order exactly
  const args: FclArg[] = [
    { type: "String",  value: proxyAddress },     // proxyHex — EVM.addressFromString accepts 0x-prefixed
    { type: "String",  value: evmCalldataHex },   // calldataHex — raw hex, no 0x
    { type: "String",  value: recipientEvmHex },  // 40-char no 0x
    { type: "Array",   value: Array.from(orchResult.encryptedNoteTo).map(b => ({ type: "UInt8",   value: b.toString() })) },
    { type: "UInt256", value: orchResult.ephPubkeyToX.toString() },
    { type: "UInt256", value: orchResult.ephPubkeyToY.toString() },
    { type: "Array",   value: Array.from(orchResult.encryptedSnapshot).map(b => ({ type: "UInt8", value: b.toString() })) },
    { type: "UInt256", value: orchResult.ephPubkeyX.toString() },
    { type: "UInt256", value: orchResult.ephPubkeyY.toString() },
  ];

  return { cadence, args, evmCalldataHex };
}

// ─── buildShieldedTransferFTPlusRecordTipEvmTx ───────────────────────────────

export interface BuildShieldedTransferFTPlusRecordTipEvmTxArgs {
  /**
   * Cadence address of the deployed PrivateTip contract (with 0x prefix).
   * Example: "0xd32d9100e1fe983b"
   */
  privateTipAddress: string;
  /**
   * Cadence address of the JanusFT contract (with 0x prefix).
   * Example: TOKEN_REGISTRY.mockft.cadenceAddress = "0xc4e8f99915893a2f"
   */
  janusftAddress: string;
  /** Sender's Cadence address (with 0x prefix). */
  fromAccount: string;
  /** FT recipient's Cadence address (with 0x prefix) — used by JanusFT registry. */
  toAccount: string;
  /**
   * 40-char EVM hex WITHOUT 0x prefix — the recipient's COA EVM address,
   * stored in PrivateTip.EvmRecipientStore.
   */
  recipientEvmHex: string;
  /** Result from orchestrateShieldedTransfer. */
  orchResult: ShieldedTransferOrchestrateResult;
}

/**
 * Build a combined Cadence tx that atomically:
 *   1. Calls JanusFT.shieldedTransfer (Cadence FT path, e.g. MockFT).
 *   2. Calls PrivateTip.recordTipWithSenderSnapshotEVM.
 *
 * The JanusFT shieldedTransfer and PrivateTip EVM recording share the same
 * snapshot/note ciphertext blobs — no duplication in tx args.
 *
 * @example
 * const { cadence, args } = buildShieldedTransferFTPlusRecordTipEvmTx({
 *   privateTipAddress: "0xd32d9100e1fe983b",
 *   janusftAddress: TOKEN_REGISTRY.mockft.cadenceAddress,
 *   fromAccount: eveSender.cadenceAddr,
 *   toAccount: bobRecipient.cadenceAddr,
 *   recipientEvmHex: bobRecipient.coaEvm.slice(2),
 *   orchResult,
 * });
 */
export function buildShieldedTransferFTPlusRecordTipEvmTx(
  input: BuildShieldedTransferFTPlusRecordTipEvmTxArgs
): { cadence: string; args: FclArg[] } {
  const tipAddrHex = input.privateTipAddress.replace(/^0x/, "");
  const ftAddrHex  = input.janusftAddress.replace(/^0x/, "");
  const recipientEvmHex = input.recipientEvmHex.replace(/^0x/, "");
  const { orchResult } = input;

  const cadence = `import JanusFT from 0x${ftAddrHex}
import EVM from 0x8c5303eaa26202d6
import PrivateTip from 0x${tipAddrHex}

transaction(
    fromAccount: Address,
    toAccount: Address,
    transferProof: [UInt256],
    publicInputs: [UInt256],
    encSnapshotFrom: [UInt8],
    ephFromX: UInt256,
    ephFromY: UInt256,
    encNoteTo: [UInt8],
    ephToX: UInt256,
    ephToY: UInt256,
    recipientEvmHex: String
) {
    let reg: &JanusFT.CommitmentRegistry
    let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    let sig: auth(BorrowValue) &Account

    prepare(signer: auth(BorrowValue) &Account) {
        self.sig = signer
        self.reg = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
        ) ?? panic("no JanusFT registry — run installRegistry first")
        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("no COA at /storage/evm")
    }

    execute {
        // 1. Execute JanusFT shielded transfer (Cadence FT path)
        self.reg.shieldedTransfer(
            fromAccount: fromAccount,
            toAccount: toAccount,
            transferProof: transferProof,
            publicInputs: publicInputs,
            encryptedSnapshotFrom: encSnapshotFrom,
            ephPubFromX: ephFromX,
            ephPubFromY: ephFromY,
            encryptedNoteTo: encNoteTo,
            ephPubToX: ephToX,
            ephPubToY: ephToY,
            coa: self.coa
        )

        // 2. Record EVM-recipient tip with sender snapshot (atomic)
        // encSnapshotFrom == senderSnapshotCiphertext (same key material reused)
        // encNoteTo       == memoCiphertext           (same key material reused)
        let tipID = PrivateTip.recordTipWithSenderSnapshotEVM(
            sender: self.sig,
            recipientEvmHex: recipientEvmHex,
            memoCiphertext: encNoteTo,
            memoEphPubkeyX: ephToX,
            memoEphPubkeyY: ephToY,
            senderSnapshotCiphertext: encSnapshotFrom,
            senderSnapshotEphPubkeyX: ephFromX,
            senderSnapshotEphPubkeyY: ephFromY
        )
        log("JanusFT EVM tip tipID=".concat(tipID.toString()))
    }
}`;

  // Args order matches tx parameter order exactly
  const args: FclArg[] = [
    { type: "Address", value: input.fromAccount },
    { type: "Address", value: input.toAccount },
    { type: "Array",   value: Array.from(orchResult.proof).map(v => ({ type: "UInt256", value: v.toString() })) },
    { type: "Array",   value: Array.from(orchResult.publicInputs).map(v => ({ type: "UInt256", value: v.toString() })) },
    { type: "Array",   value: Array.from(orchResult.encryptedSnapshot).map(b => ({ type: "UInt8", value: b.toString() })) },
    { type: "UInt256", value: orchResult.ephPubkeyX.toString() },
    { type: "UInt256", value: orchResult.ephPubkeyY.toString() },
    { type: "Array",   value: Array.from(orchResult.encryptedNoteTo).map(b => ({ type: "UInt8", value: b.toString() })) },
    { type: "UInt256", value: orchResult.ephPubkeyToX.toString() },
    { type: "UInt256", value: orchResult.ephPubkeyToY.toString() },
    { type: "String",  value: recipientEvmHex },
  ];

  return { cadence, args };
}

// ─── buildGetShieldedTipsBySenderWithSnapshotEvmScript ───────────────────────

/**
 * Build a Cadence script that queries all EVM-recipient tips for a sender.
 *
 * Returns TipMetadataEvm[] from PrivateTip.getShieldedTipsBySenderWithSnapshotEVM.
 * Each entry carries tipID, sender, recipientEvmHex, and the encrypted
 * memo + senderSnapshot blobs for decryption.
 *
 * @example
 * const { script, args } = buildGetShieldedTipsBySenderWithSnapshotEvmScript(
 *   "0xd32d9100e1fe983b",
 *   bobCadenceAddr,
 * );
 */
export function buildGetShieldedTipsBySenderWithSnapshotEvmScript(
  privateTipAddress: string,
  sender: string
): { script: string; args: FclArg[] } {
  const addrHex = privateTipAddress.replace(/^0x/, "");

  const script = `import PrivateTip from 0x${addrHex}

access(all) fun main(sender: Address): [PrivateTip.TipMetadataEvm] {
    return PrivateTip.getShieldedTipsBySenderWithSnapshotEVM(sender: sender)
}`;

  const args: FclArg[] = [
    { type: "Address", value: sender },
  ];

  return { script, args };
}
