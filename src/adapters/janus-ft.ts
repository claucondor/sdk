/**
 * adapters/janus-ft.ts — JanusTokenAdapter for variant="cadence-ft" (JanusFT).
 *
 * Wraps a Cadence FungibleToken vault. Generic wrapper — accepts any underlying
 * FungibleToken configured in JanusFT.custodyVaultType (set at deploy time).
 * For testnet, the underlying is MockFT. At mainnet, swap to the production FT.
 *
 * Key differences from EVM adapters:
 *   - wrap() signature has BOTH grossAmount and netAmount (explicit safety check)
 *   - Proofs use v0.3 circuit ceremony zkeys (same as EVM — shared ceremonies)
 *   - Proof packing: applyPiBSwap REQUIRED for Cadence's _verifyGroth16 call
 *   - UFix64 amounts: divide by 10^8 to get UFix64 string for FCL args
 *   - Addresses are Cadence hex addresses (0x7-prefix), not EVM hex
 *
 * Selector trap: Cadence's cross-VM calldata for EVM selectors uses CANONICAL
 * uint256[N] form (not uint[N]). The deployed JanusFT hardcodes the correct
 * selectors. The SDK does NOT build cross-VM calldata here — it calls Cadence
 * transactions directly which handle the selector internally.
 *
 * EVM-side reads (commitment, memoKey): JanusFT reads from Cadence scripts.
 */

import type { JanusTokenAdapter, EVMSigner } from "./JanusTokenAdapter";
import type {
  BabyJubKeypair,
  WrapParams,
  WrapResult,
  SendParams,
  SendResult,
  UnwrapParams,
  UnwrapResult,
  TxResult,
  DepositRecord,
  NoteContent,
  SnapshotContent,
} from "../types";
import type { Point } from "../types/commitment";
import type { ProofUint256 } from "../types/proof";
import type { CadenceFTTokenEntry } from "../types";
import { FLOW_CADENCE_ACCESS, UFIX64_SCALE } from "../network/contracts";
import { orchestrateWrap, orchestrateWrapWithPrebuiltProof } from "../orchestration/wrap";
import { orchestrateShieldedTransfer, orchestrateShieldedTransferWithPrebuiltProof } from "../orchestration/shielded-transfer";
import { orchestrateUnwrap, orchestrateUnwrapWithPrebuiltProofs } from "../orchestration/unwrap";
import { decryptSnapshot } from "../crypto/snapshot-schema";
import { decryptNote } from "../crypto/note-schema";
import {
  scanCadenceSnapshots,
  scanCadenceIncomingNotes,
} from "../scan/cadence-scanner";

// Cadence transaction templates for JanusFT v0.6
// These templates use the contract at the configured cadenceAddress.
// The underlying FT (MockFT for testnet) is imported inline where needed.

function buildWrapTx(contractAddr: string, ftContractName: string, ftAddress: string): string {
  return `
import JanusFT from ${contractAddr}
import ${ftContractName} from ${ftAddress}
import FungibleToken from 0x9a0766d93b6608b7
import EVM from 0x8c5303eaa26202d6

transaction(
  registryAddr: Address,
  grossAmount: UFix64,
  netAmount: UFix64,
  txCommitX: UInt256, txCommitY: UInt256,
  amountProof: [UInt256],
  amountPublicInputs: [UInt256],
  encryptedSnapshot: [UInt8],
  ephPubX: UInt256, ephPubY: UInt256
) {
  let depositVault: @{FungibleToken.Vault}
  let registryRef: &JanusFT.CommitmentRegistry
  let senderAddress: Address
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.senderAddress = signer.address
    let userVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &${ftContractName}.Vault>(
      from: ${ftContractName}.VaultStoragePath
    ) ?? panic("wrap_ft: signer has no ${ftContractName} vault")
    self.depositVault <- userVault.withdraw(amount: grossAmount)
    self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
      from: JanusFT.CommitmentRegistryStoragePath
    ) ?? panic("wrap_ft: signer must hold the JanusFT registry")
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("wrap_ft: no COA at /storage/evm")
  }

  execute {
    self.registryRef.wrap(
      account: self.senderAddress,
      netAmount: netAmount,
      depositVault: <- self.depositVault,
      txCommit: JanusFT.Commitment(x: txCommitX, y: txCommitY),
      amountProof: amountProof,
      amountPublicInputs: amountPublicInputs,
      encryptedSnapshot: encryptedSnapshot,
      ephPubX: ephPubX,
      ephPubY: ephPubY,
      coa: self.coa
    )
  }
}
`;
}

function buildShieldedTransferTx(contractAddr: string): string {
  return `
import JanusFT from ${contractAddr}
import EVM from 0x8c5303eaa26202d6

transaction(
  fromAccount: Address,
  toAccount: Address,
  transferProof: [UInt256],
  publicInputs: [UInt256],
  encryptedSnapshotFrom: [UInt8], ephPubFromX: UInt256, ephPubFromY: UInt256,
  encryptedNoteTo: [UInt8], ephPubToX: UInt256, ephPubToY: UInt256
) {
  let registryRef: &JanusFT.CommitmentRegistry
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
      from: JanusFT.CommitmentRegistryStoragePath
    ) ?? panic("shielded_transfer_ft: signer must hold the JanusFT registry")
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("shielded_transfer_ft: no COA at /storage/evm")
  }

  execute {
    self.registryRef.shieldedTransfer(
      fromAccount: fromAccount,
      toAccount: toAccount,
      transferProof: transferProof,
      publicInputs: publicInputs,
      encryptedSnapshotFrom: encryptedSnapshotFrom,
      ephPubFromX: ephPubFromX,
      ephPubFromY: ephPubFromY,
      encryptedNoteTo: encryptedNoteTo,
      ephPubToX: ephPubToX,
      ephPubToY: ephPubToY,
      coa: self.coa
    )
  }
}
`;
}

function buildUnwrapTx(contractAddr: string, ftContractName: string, ftAddress: string): string {
  return `
import JanusFT from ${contractAddr}
import ${ftContractName} from ${ftAddress}
import FungibleToken from 0x9a0766d93b6608b7
import EVM from 0x8c5303eaa26202d6

transaction(
  account: Address,
  claimedAmount: UFix64,
  recipient: Address,
  txCommitX: UInt256, txCommitY: UInt256,
  amountProof: [UInt256],
  amountPublicInputs: [UInt256],
  transferProof: [UInt256],
  transferPublicInputs: [UInt256],
  encryptedSnapshot: [UInt8], ephPubX: UInt256, ephPubY: UInt256
) {
  let registryRef: &JanusFT.CommitmentRegistry
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
  let recipientRef: &{FungibleToken.Receiver}

  prepare(signer: auth(BorrowValue) &Account) {
    self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
      from: JanusFT.CommitmentRegistryStoragePath
    ) ?? panic("unwrap_ft: signer must hold the JanusFT registry")
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("unwrap_ft: no COA at /storage/evm")
    self.recipientRef = getAccount(recipient)
      .capabilities.borrow<&{FungibleToken.Receiver}>(${ftContractName}.ReceiverPublicPath)
      ?? panic("unwrap_ft: recipient has no ${ftContractName} receiver")
  }

  execute {
    let netVault <- self.registryRef.unwrap(
      account: account,
      claimedAmount: claimedAmount,
      recipient: recipient,
      txCommit: JanusFT.Commitment(x: txCommitX, y: txCommitY),
      amountProof: amountProof,
      amountPublicInputs: amountPublicInputs,
      transferProof: transferProof,
      transferPublicInputs: transferPublicInputs,
      encryptedSnapshot: encryptedSnapshot,
      ephPubX: ephPubX,
      ephPubY: ephPubY,
      coa: self.coa
    )
    self.recipientRef.deposit(from: <- netVault)
  }
}
`;
}

function buildPublishMemoKeyTx(contractAddr: string): string {
  // JanusFT delegates to the shared JanusFlow.MemoKey resource at
  // /storage/openjanusMemoKey — publishing once makes the pubkey readable
  // from all Janus Cadence apps.
  return `
import JanusFT from ${contractAddr}
import JanusFlow from 0x5dcbeb41055ec57e

transaction(pubkeyX: UInt256, pubkeyY: UInt256) {
  prepare(signer: auth(SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account) {
    JanusFT.publishMemoKey(account: signer, pubkeyX: pubkeyX, pubkeyY: pubkeyY)
  }
}
`;
}

/**
 * Pre-built AmountDisclose proof for wrapViaCoa (browser callers).
 * POST to /api/proof/wrap server-side, then pass the result here.
 */
export interface FTWrapViaCoaPrebuiltProof {
  proof: ProofUint256;
  txCommit: readonly [bigint, bigint];
  blinding: bigint;
  publicInputs: readonly [bigint, bigint, bigint];
}

/**
 * Pre-built ConfidentialTransfer proof for shieldedTransferViaCoa (browser callers).
 * POST to /api/proof/shielded-transfer, pass the result here.
 */
export interface FTShieldedTransferViaCoaPrebuiltProof {
  proof: ProofUint256;
  publicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  transferBlinding: bigint;
  newBlinding: bigint;
}

/**
 * Pre-built proofs for unwrapViaCoa (browser callers).
 * POST to /api/proof/unwrap, pass the result here.
 */
export interface FTUnwrapViaCoaPrebuiltProofs {
  amountProof: ProofUint256;
  txCommit: readonly [bigint, bigint];
  amountPublicInputs: readonly [bigint, bigint, bigint];
  transferProof: ProofUint256;
  transferPublicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  newBlinding: bigint;
}

/** Convert bigint raw amount (10^8 units) to UFix64 string "N.XXXXXXXX" */
function rawToUFix64(raw: bigint): string {
  const whole = raw / UFIX64_SCALE;
  const frac = raw % UFIX64_SCALE;
  return `${whole}.${frac.toString().padStart(8, "0")}`;
}

export class JanusFTAdapter implements JanusTokenAdapter {
  readonly id: string;
  readonly variant = "cadence-ft" as const;
  readonly address: string;  // Cadence address
  readonly decimals: number;

  private readonly entry: CadenceFTTokenEntry;
  private readonly accessApiUrl: string;

  constructor(id: string, entry: CadenceFTTokenEntry, accessApiUrl = FLOW_CADENCE_ACCESS) {
    this.id = id;
    this.entry = entry;
    this.address = entry.cadenceAddress;
    this.decimals = entry.decimals;
    this.accessApiUrl = accessApiUrl;
  }

  private async _fcl() {
    const fcl = await import("@onflow/fcl");
    fcl.config({ "accessNode.api": this.accessApiUrl });
    return fcl;
  }

  private async _fclTypes() {
    return import("@onflow/types");
  }

  async getBalance(addr: string): Promise<bigint> {
    const fcl = await this._fcl();
    const t = await this._fclTypes();
    const script = `
import ${this.entry.ftContractName} from ${this.entry.ftAddress}
import FungibleToken from 0x9a0766d93b6608b7

access(all) fun main(addr: Address): UFix64 {
  let acct = getAccount(addr)
  let cap = acct.capabilities.borrow<&{FungibleToken.Balance}>(${this.entry.ftContractName}.BalancePublicPath)
    ?? panic("No balance capability")
  return cap.balance
}
`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await fcl.query({
      cadence: script,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [arg(addr, types.Address)],
    });
    // UFix64 → bigint (multiply by 10^8)
    const floatVal = parseFloat(result as string);
    return BigInt(Math.round(floatVal * 1e8));
  }

  async getCommitment(addr: string): Promise<Point> {
    const fcl = await this._fcl();
    const t = await this._fclTypes();
    const script = `
import ${this.entry.contractName} from ${this.entry.cadenceAddress}

access(all) fun main(addr: Address): {String: UInt256} {
  let c = ${this.entry.contractName}.balanceOfCommitment(account: addr)
  return {"x": c.x, "y": c.y}
}
`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await fcl.query({
      cadence: script,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [arg(addr, types.Address)],
    });
    return { x: BigInt(result.x), y: BigInt(result.y) };
  }

  /**
   * Read the user's MemoKey from the shared JanusFlow MemoKey resource at
   * 0x5dcbeb41055ec57e. JanusFT (and all v0.6 Cadence Janus tokens) use
   * a SHARED memokey registry — publishing on JanusFlow.MemoKey makes the
   * pubkey readable from any Janus Cadence app via JanusFlow.getMemoPubkey(owner).
   * Returns null if no MemoKey resource is published at /public/openjanusMemoKey.
   */
  async getMemoKey(addr: string): Promise<{ x: bigint; y: bigint } | null> {
    const fcl = await this._fcl();
    const script = `
import JanusFlow from 0x5dcbeb41055ec57e

access(all) fun main(addr: Address): {String: UInt256}? {
  return JanusFlow.getMemoPubkey(owner: addr)
}
`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await fcl.query({
        cadence: script,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: (arg: any, types: any) => [arg(addr, types.Address)],
      });
      if (result === null || result === undefined) return null;
      const x = BigInt(result.x ?? 0);
      const y = BigInt(result.y ?? 0);
      if (x === 0n && y === 0n) return null;
      return { x, y };
    } catch {
      return null;
    }
  }

  async getFirstSnapshotBlock(_addr: string): Promise<bigint> {
    // Cadence FT doesn't use EVM block numbers — return 0n
    // Scan will use a fallback window in this case
    return 0n;
  }

  async feeBps(): Promise<number> {
    const fcl = await this._fcl();
    const script = `
import ${this.entry.contractName} from ${this.entry.cadenceAddress}
access(all) fun main(): UInt16 { return ${this.entry.contractName}.feeBps() }
`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await fcl.query({ cadence: script, args: () => [] });
    return Number(result);
  }

  async feeRecipient(): Promise<string> {
    const fcl = await this._fcl();
    const script = `
import ${this.entry.contractName} from ${this.entry.cadenceAddress}
access(all) fun main(): Address { return ${this.entry.contractName}.feeRecipient() }
`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await fcl.query({ cadence: script, args: () => [] });
    return result as string;
  }

  async computeNet(gross: bigint): Promise<bigint> {
    const bps = await this.feeBps();
    if (bps === 0) return gross;
    return gross - (gross * BigInt(bps)) / 10000n;
  }

  async publishMemoKey(memoKeypair: BabyJubKeypair, _signer: EVMSigner): Promise<TxResult> {
    // For Cadence FT, signer is the FCL-authorized account
    // EVMSigner param is ignored — FCL handles signing via its own authz
    const fcl = await this._fcl();
    const t = await this._fclTypes();
    const cadence = buildPublishMemoKeyTx(this.entry.cadenceAddress);
    const txId: string = await fcl.mutate({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [
        arg(memoKeypair.pubkey.x.toString(), types.UInt256),
        arg(memoKeypair.pubkey.y.toString(), types.UInt256),
      ],
    });
    await fcl.tx(txId).onceSealed();
    return { txHash: txId };
  }

  /**
   * wrapViaCoa — browser-safe wrap for Cadence FT.
   *
   * Takes a pre-built proof (from POST /api/proof/wrap — Node.js) and the
   * user's Cadence address + COA address. Dispatches a Cadence transaction
   * via FCL so the user's COA is the EVM msg.sender.
   *
   * @param params.grossAmount     Gross amount in raw units (UFix64 * 10^8).
   * @param params.coaEvmAddr      User's COA EVM hex address (for memoKey lookup).
   * @param params.userCadenceAddr User's Flow wallet address (FCL signer context).
   * @param params.prebuiltProof   Proof built server-side via /api/proof/wrap.
   */
  async wrapViaCoa(params: WrapParams & {
    coaEvmAddr: string;
    userCadenceAddr: string;
    prebuiltProof: FTWrapViaCoaPrebuiltProof;
  }): Promise<WrapResult> {
    const fcl = await this._fcl();
    const t = await this._fclTypes();

    const memoKey = await this.getMemoKey(params.coaEvmAddr);
    if (!memoKey) {
      throw new Error(
        `JanusFTAdapter.wrapViaCoa: COA ${params.coaEvmAddr} has no registered memoKey. Run publishMemoKey first.`
      );
    }

    const bps = await this.feeBps();
    const fee = bps === 0 ? 0n : (params.grossAmount * BigInt(bps)) / 10000n;
    const netAmount = params.grossAmount - fee;

    const orch = await orchestrateWrapWithPrebuiltProof({
      grossAmount: params.grossAmount,
      feeBps: bps,
      senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
      proof: params.prebuiltProof.proof,
      txCommit: params.prebuiltProof.txCommit,
      blinding: params.prebuiltProof.blinding,
      publicInputs: params.prebuiltProof.publicInputs,
    });

    const cadence = buildWrapTx(this.entry.cadenceAddress, this.entry.ftContractName, this.entry.ftAddress);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txId: string = await fcl.mutate({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [
        arg(params.userCadenceAddr, types.Address),
        arg(rawToUFix64(params.grossAmount), types.UFix64),
        arg(rawToUFix64(netAmount), types.UFix64),
        arg(orch.txCommit[0].toString(), types.UInt256),
        arg(orch.txCommit[1].toString(), types.UInt256),
        arg(orch.amountProof.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.amountPublicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(Array.from(orch.encryptedSnapshot).map(String), types.Array(types.UInt8)),
        arg(orch.ephPubkeyX.toString(), types.UInt256),
        arg(orch.ephPubkeyY.toString(), types.UInt256),
      ],
      proposer: fcl.authz,
      payer: fcl.authz,
      authorizations: [fcl.authz],
      limit: 9999,
    });
    await fcl.tx(txId).onceSealed();
    return { txHash: txId, netAmount: orch.netAmount, fee: orch.fee };
  }

  /**
   * shieldedTransferViaCoa — browser-safe shielded transfer for Cadence FT.
   *
   * @param params.coaEvmAddr      Sender's COA EVM hex address (for memoKey lookup).
   * @param params.userCadenceAddr Sender's Flow wallet address (FCL signer context).
   * @param params.prebuiltProof   Proof built server-side via /api/proof/shielded-transfer.
   */
  async shieldedTransferViaCoa(params: SendParams & {
    coaEvmAddr: string;
    userCadenceAddr: string;
    prebuiltProof: FTShieldedTransferViaCoaPrebuiltProof;
  }): Promise<SendResult> {
    const fcl = await this._fcl();
    const t = await this._fclTypes();

    const [senderMemoKey, recipientMemoKey] = await Promise.all([
      this.getMemoKey(params.coaEvmAddr),
      this.getMemoKey(params.recipient),
    ]);
    if (!senderMemoKey) {
      throw new Error(
        `JanusFTAdapter.shieldedTransferViaCoa: COA ${params.coaEvmAddr} has no registered memoKey.`
      );
    }
    if (!recipientMemoKey) {
      throw new Error(
        `JanusFTAdapter.shieldedTransferViaCoa: recipient ${params.recipient} has no memoKey.`
      );
    }

    const orch = await orchestrateShieldedTransferWithPrebuiltProof({
      currentBalance: params.currentBalance,
      transferAmount: params.amount,
      senderMemoKeypair: { privkey: 0n, pubkey: senderMemoKey },
      recipientMemoKey,
      memo: params.memo,
      proof: params.prebuiltProof.proof,
      publicInputs: params.prebuiltProof.publicInputs,
      transferBlinding: params.prebuiltProof.transferBlinding,
      newBlinding: params.prebuiltProof.newBlinding,
    });

    const cadence = buildShieldedTransferTx(this.entry.cadenceAddress);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txId: string = await fcl.mutate({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [
        arg(params.userCadenceAddr, types.Address),
        arg(params.recipient, types.Address),
        arg(orch.proof.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.publicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(Array.from(orch.encryptedSnapshot).map(String), types.Array(types.UInt8)),
        arg(orch.ephPubkeyX.toString(), types.UInt256),
        arg(orch.ephPubkeyY.toString(), types.UInt256),
        arg(Array.from(orch.encryptedNoteTo).map(String), types.Array(types.UInt8)),
        arg(orch.ephPubkeyToX.toString(), types.UInt256),
        arg(orch.ephPubkeyToY.toString(), types.UInt256),
      ],
      proposer: fcl.authz,
      payer: fcl.authz,
      authorizations: [fcl.authz],
      limit: 9999,
    });
    await fcl.tx(txId).onceSealed();
    return { txHash: txId };
  }

  /**
   * unwrapViaCoa — browser-safe unwrap for Cadence FT.
   *
   * @param params.coaEvmAddr      User's COA EVM hex address (for memoKey lookup).
   * @param params.userCadenceAddr User's Flow wallet address (FCL signer context).
   * @param params.prebuiltProofs  Proofs built server-side via /api/proof/unwrap.
   */
  async unwrapViaCoa(params: UnwrapParams & {
    coaEvmAddr: string;
    userCadenceAddr: string;
    prebuiltProofs: FTUnwrapViaCoaPrebuiltProofs;
  }): Promise<UnwrapResult> {
    const fcl = await this._fcl();
    const t = await this._fclTypes();

    const memoKey = await this.getMemoKey(params.coaEvmAddr);
    if (!memoKey) {
      throw new Error(
        `JanusFTAdapter.unwrapViaCoa: COA ${params.coaEvmAddr} has no registered memoKey.`
      );
    }

    const bps = await this.feeBps();
    const orch = await orchestrateUnwrapWithPrebuiltProofs({
      claimedAmount: params.claimedAmount,
      feeBps: bps,
      currentBalance: params.currentBalance,
      senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
      amountProof: params.prebuiltProofs.amountProof,
      txCommit: params.prebuiltProofs.txCommit,
      amountPublicInputs: params.prebuiltProofs.amountPublicInputs,
      transferProof: params.prebuiltProofs.transferProof,
      transferPublicInputs: params.prebuiltProofs.transferPublicInputs,
      newBlinding: params.prebuiltProofs.newBlinding,
    });

    const cadence = buildUnwrapTx(this.entry.cadenceAddress, this.entry.ftContractName, this.entry.ftAddress);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txId: string = await fcl.mutate({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [
        arg(params.userCadenceAddr, types.Address),
        arg(rawToUFix64(params.claimedAmount), types.UFix64),
        arg(params.recipient, types.Address),
        arg(orch.txCommit[0].toString(), types.UInt256),
        arg(orch.txCommit[1].toString(), types.UInt256),
        arg(orch.amountProof.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.amountPublicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.transferProof.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.transferPublicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(Array.from(orch.encryptedSnapshot).map(String), types.Array(types.UInt8)),
        arg(orch.ephPubkeyX.toString(), types.UInt256),
        arg(orch.ephPubkeyY.toString(), types.UInt256),
      ],
      proposer: fcl.authz,
      payer: fcl.authz,
      authorizations: [fcl.authz],
      limit: 9999,
    });
    await fcl.tx(txId).onceSealed();
    return { txHash: txId, netToRecipient: orch.netToRecipient };
  }

  async wrap(params: WrapParams, _signer: EVMSigner): Promise<WrapResult> {
    const fcl = await this._fcl();
    const t = await this._fclTypes();
    const bps = await this.feeBps();
    const fee = bps === 0 ? 0n : (params.grossAmount * BigInt(bps)) / 10000n;
    const netAmount = params.grossAmount - fee;

    // We need the signer's cadence address for the registry
    // In practice the FCL authorized account is the signer
    const signerCadenceAddr = this.entry.cadenceAddress; // TODO: get from FCL currentUser in frontend

    // Need a memoKey to encrypt snapshot — for now read from chain
    const memoKey = await this.getMemoKey(signerCadenceAddr);
    if (!memoKey) throw new Error("JanusFTAdapter.wrap: signer has no memoKey");

    const orch = await orchestrateWrap({
      grossAmount: params.grossAmount,
      feeBps: bps,
      senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
    });

    const cadence = buildWrapTx(this.entry.cadenceAddress, this.entry.ftContractName, this.entry.ftAddress);
    const txId: string = await fcl.mutate({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [
        arg(signerCadenceAddr, types.Address),
        arg(rawToUFix64(params.grossAmount), types.UFix64),
        arg(rawToUFix64(netAmount), types.UFix64),
        arg(orch.txCommit[0].toString(), types.UInt256),
        arg(orch.txCommit[1].toString(), types.UInt256),
        arg(orch.amountProof.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.amountPublicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(Array.from(orch.encryptedSnapshot).map(String), types.Array(types.UInt8)),
        arg(orch.ephPubkeyX.toString(), types.UInt256),
        arg(orch.ephPubkeyY.toString(), types.UInt256),
      ],
    });
    await fcl.tx(txId).onceSealed();
    return { txHash: txId, netAmount: orch.netAmount, fee: orch.fee };
  }

  async shieldedTransfer(params: SendParams, _signer: EVMSigner): Promise<SendResult> {
    const fcl = await this._fcl();
    const t = await this._fclTypes();
    const signerCadenceAddr = this.entry.cadenceAddress;
    const [senderMemoKey, recipientMemoKey] = await Promise.all([
      this.getMemoKey(signerCadenceAddr),
      this.getMemoKey(params.recipient),
    ]);
    if (!senderMemoKey) throw new Error("JanusFTAdapter.shieldedTransfer: sender has no memoKey");
    if (!recipientMemoKey) {
      throw new Error(`JanusFTAdapter.shieldedTransfer: recipient has no memoKey`);
    }
    const orch = await orchestrateShieldedTransfer({
      currentBalance: params.currentBalance,
      currentBlinding: params.currentBlinding,
      transferAmount: params.amount,
      senderMemoKeypair: { privkey: 0n, pubkey: senderMemoKey },
      recipientMemoKey,
      memo: params.memo,
    });
    const cadence = buildShieldedTransferTx(this.entry.cadenceAddress);
    const txId: string = await fcl.mutate({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [
        arg(signerCadenceAddr, types.Address),
        arg(params.recipient, types.Address),
        arg(orch.publicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.proof.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(Array.from(orch.encryptedSnapshot).map(String), types.Array(types.UInt8)),
        arg(orch.ephPubkeyX.toString(), types.UInt256),
        arg(orch.ephPubkeyY.toString(), types.UInt256),
        arg(Array.from(orch.encryptedNoteTo).map(String), types.Array(types.UInt8)),
        arg(orch.ephPubkeyToX.toString(), types.UInt256),
        arg(orch.ephPubkeyToY.toString(), types.UInt256),
      ],
    });
    await fcl.tx(txId).onceSealed();
    return { txHash: txId };
  }

  async unwrap(params: UnwrapParams, _signer: EVMSigner): Promise<UnwrapResult> {
    const fcl = await this._fcl();
    const t = await this._fclTypes();
    const signerCadenceAddr = this.entry.cadenceAddress;
    const bps = await this.feeBps();
    const memoKey = await this.getMemoKey(signerCadenceAddr);
    if (!memoKey) throw new Error("JanusFTAdapter.unwrap: signer has no memoKey");
    const orch = await orchestrateUnwrap({
      claimedAmount: params.claimedAmount,
      feeBps: bps,
      currentBalance: params.currentBalance,
      currentBlinding: params.currentBlinding,
      senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
    });
    const cadence = buildUnwrapTx(this.entry.cadenceAddress, this.entry.ftContractName, this.entry.ftAddress);
    const txId: string = await fcl.mutate({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [
        arg(signerCadenceAddr, types.Address),
        arg(rawToUFix64(params.claimedAmount), types.UFix64),
        arg(params.recipient, types.Address),
        arg(orch.txCommit[0].toString(), types.UInt256),
        arg(orch.txCommit[1].toString(), types.UInt256),
        arg(orch.amountProof.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.amountPublicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.transferPublicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.transferProof.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(Array.from(orch.encryptedSnapshot).map(String), types.Array(types.UInt8)),
        arg(orch.ephPubkeyX.toString(), types.UInt256),
        arg(orch.ephPubkeyY.toString(), types.UInt256),
      ],
    });
    await fcl.tx(txId).onceSealed();
    return { txHash: txId, netToRecipient: orch.netToRecipient };
  }

  /**
   * Scan ShieldedTransferWithSnapshot events on JanusFT for incoming notes
   * addressed to `addr`. Uses Flow REST events API.
   */
  async scanDeposits(addr: string, fromBlock?: bigint): Promise<DepositRecord[]> {
    const records = await scanCadenceIncomingNotes(
      addr,
      this.entry.cadenceAddress,
      this.entry.contractName,
      {
        accessApi: this.accessApiUrl,
        ...(fromBlock !== undefined ? { fromBlock: Number(fromBlock) } : {}),
      }
    );
    return records.map((r) => ({
      ciphertext: r.ciphertext,
      ephPubkey: r.ephPubkey,
      timestampMs: r.timestampMs,
      txHash: r.txHash,
      blockNumber: r.blockHeight,
    }));
  }

  async decryptNoteTo(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<NoteContent> {
    return decryptNote(blob, ephPub, myMemoPrivKey);
  }

  async decryptSnapshot(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<SnapshotContent> {
    const result = await decryptSnapshot(blob, ephPub, myMemoPrivKey);
    if (result === null) throw new Error("JanusFTAdapter.decryptSnapshot: decryption failed");
    return result;
  }

  /**
   * Reconstruct the latest shielded state from on-chain Cadence events.
   * Scans WrapWithSnapshot / ShieldedTransferWithSnapshot (sender side) /
   * UnwrapWithSnapshot, decrypts each blob, picks highest timestampMs.
   */
  async latestSnapshot(addr: string, myMemoPrivKey: bigint): Promise<SnapshotContent> {
    const events = await scanCadenceSnapshots(
      addr,
      this.entry.cadenceAddress,
      this.entry.contractName,
      { accessApi: this.accessApiUrl }
    );
    if (events.length === 0) {
      throw new Error(`JanusFTAdapter.latestSnapshot: no snapshot events found for ${addr}`);
    }

    const decoded: SnapshotContent[] = [];
    for (const ev of events) {
      const snap = await decryptSnapshot(ev.ciphertext, ev.ephPubkey, myMemoPrivKey);
      if (snap !== null) decoded.push(snap);
    }
    if (decoded.length === 0) {
      throw new Error(
        `JanusFTAdapter.latestSnapshot: ${events.length} snapshot events found for ${addr} but none decrypted with the supplied memoPrivKey`
      );
    }
    decoded.sort((a, b) => b.timestampMs - a.timestampMs);
    return decoded[0]!;
  }
}
