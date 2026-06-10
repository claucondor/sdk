/**
 * adapters/janus-ft.ts — JanusTokenAdapter for variant="cadence-ft" (JanusFT v0.8).
 *
 * Wraps a Cadence FungibleToken vault via FCL. For testnet the underlying is MockFT.
 *
 * v0.8 changes:
 *   - All Cadence contracts at 0x4b6bc58bc8bf5dcc (was 0xc4e8f99915893a2f)
 *   - JanusFT.shieldedTransfer: drops encryptedSnapshotFrom + ephPubFromX/Y args (v0.7 → v0.8)
 *   - JanusFT uses v0.7 verifier addresses embedded at deploy (separate from JanusFlow v0.8 verifiers)
 *   - Inbox.deposit() called internally by JanusFT on transfer (not by SDK)
 *   - MemoKeyRegistry at 0x361bD4d037838A3a9c5408AE465d36077800ee6c (v0.8)
 *   - getFirstSnapshotBlock / scanDeposits / latestSnapshot: removed (use ShieldedInboxClient)
 *
 * Proof pB convention for Cadence: NATURAL snarkjs order (JanusFT does Fp2-swap internally).
 * shieldedTransfer/unwrap: flat [UInt256; 8] with pB PRE-SWAPPED (EVM order = same as EVM adapters).
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
  NoteContent,
  SnapshotContent,
} from "../types";
import type { Point } from "../types/commitment";
import type { ProofUint256 } from "../types/proof";
import type { CadenceFTTokenEntry } from "../types";
import { ethers } from "ethers";
import { FLOW_CADENCE_ACCESS, FLOW_EVM_RPC, MEMO_REGISTRY_ADDRESS, UFIX64_SCALE } from "../network/contracts";
import { getCoaEvmAddress } from "../network/coa";
import { buildBatchClaimProof } from "../proof/batch-claim";
import type { BatchClaimProofOptions } from "../proof/batch-claim";
import { orchestrateWrap, orchestrateWrapWithPrebuiltProof } from "../orchestration/wrap";
import { orchestrateShieldedTransfer, orchestrateShieldedTransferWithPrebuiltProof } from "../orchestration/shielded-transfer";
import { orchestrateUnwrap, orchestrateUnwrapWithPrebuiltProofs } from "../orchestration/unwrap";
import { decryptNote } from "../crypto/note-helpers";
import { decryptSnapshot } from "../crypto/checkpoint-schema";

// ---------------------------------------------------------------------------
// Proof splitting helpers for Cadence vs EVM paths
// ---------------------------------------------------------------------------

/**
 * Split a ProofUint256 (uint256[8], pB already Fp2-swapped for EVM) into
 * pA/pB/pC in NATURAL SNARKJS ORDER for JanusFT.wrapWithProof.
 * JanusFT does the Fp2-swap internally, so we must UN-swap here.
 *
 * ProofUint256 layout (EVM):
 *   [pA[0], pA[1], pB[0][1], pB[0][0], pB[1][1], pB[1][0], pC[0], pC[1]]
 *
 * Natural order for Cadence:
 *   pB = [[proof[3], proof[2]], [proof[5], proof[4]]]
 */
function splitProofForCadence(proof: ProofUint256 | readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]): {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
} {
  return {
    pA: [proof[0], proof[1]],
    pB: [
      [proof[3], proof[2]],
      [proof[5], proof[4]],
    ],
    pC: [proof[6], proof[7]],
  };
}

/** Convert bigint raw amount (10^8 units) to UFix64 string "N.XXXXXXXX" */
function rawToUFix64(raw: bigint): string {
  const whole = raw / UFIX64_SCALE;
  const frac = raw % UFIX64_SCALE;
  return `${whole}.${frac.toString().padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// Cadence transaction templates (v0.8 — 0x4b6bc58bc8bf5dcc)
// ---------------------------------------------------------------------------

function buildWrapTx(contractAddr: string, ftContractName: string, ftAddress: string): string {
  return `
import JanusFT from ${contractAddr}
import ${ftContractName} from ${ftAddress}
import FungibleToken from 0x9a0766d93b6608b7
import EVM from 0x8c5303eaa26202d6

transaction(
  registryAddr: Address,
  grossAmount: UFix64,
  nonce: UInt256,
  commitX: UInt256, commitY: UInt256,
  pA: [UInt256],
  pB: [[UInt256]],
  pC: [UInt256],
  encryptedSnapshot: [UInt8],
  ephPubkeyX: UInt256, ephPubkeyY: UInt256
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
    ) ?? panic("wrap_ft: no COA at /storage/evm — run setup_coa first")
  }

  execute {
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
  }
}
`;
}

/**
 * v0.8 shielded transfer: drops sender-snapshot args.
 * JanusFT.shieldedTransfer(fromAccount, toAccount, transferProof, publicInputs, encryptedNoteTo, ephPubToX, ephPubToY)
 */
function buildShieldedTransferTx(contractAddr: string): string {
  return `
import JanusFT from ${contractAddr}
import EVM from 0x8c5303eaa26202d6

transaction(
  fromAccount: Address,
  toAccount: Address,
  transferProof: [UInt256],
  publicInputs: [UInt256],
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
      fromAccount:    fromAccount,
      toAccount:      toAccount,
      transferProof:  transferProof,
      publicInputs:   publicInputs,
      encryptedNoteTo: encryptedNoteTo,
      ephPubToX:      ephPubToX,
      ephPubToY:      ephPubToY,
      coa:            self.coa
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

/**
 * Idempotent install-registry transaction.
 * Must run once before the user's first MockFT wrap.
 */
function buildInstallUserRegistryTx(contractAddr: string, ftContractName: string, ftAddress: string): string {
  return `
import JanusFT from ${contractAddr}
import ${ftContractName} from ${ftAddress}
import FungibleToken from 0x9a0766d93b6608b7

transaction {
  prepare(signer: auth(BorrowValue, SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account) {
    let storagePath = JanusFT.CommitmentRegistryStoragePath
    let publicPath  = JanusFT.CommitmentRegistryPublicPath

    let storedType = signer.storage.type(at: storagePath)

    if storedType == nil {
      let emptyVault <- ${ftContractName}.createEmptyVault(vaultType: Type<@${ftContractName}.Vault>())
      let registry   <- JanusFT.createRegistry(vault: <- emptyVault)
      signer.storage.save(<- registry, to: storagePath)
    } else if storedType == Type<@JanusFT.CommitmentRegistry>() {
      // no-op
    } else {
      let stale <- signer.storage.load<@AnyResource>(from: storagePath)
        ?? panic("user_install_janus_ft_registry: expected stale resource but load returned nil")
      destroy stale
      let emptyVault <- ${ftContractName}.createEmptyVault(vaultType: Type<@${ftContractName}.Vault>())
      let registry   <- JanusFT.createRegistry(vault: <- emptyVault)
      signer.storage.save(<- registry, to: storagePath)
    }

    signer.capabilities.unpublish(publicPath)
    let cap = signer.capabilities.storage.issue<&{JanusFT.CommitmentRegistryPublic}>(storagePath)
    signer.capabilities.publish(cap, at: publicPath)
  }
}
`;
}

/**
 * v0.8.1 claimBatch: aggregate ShieldedInbox notes into the caller's JanusFT commitment.
 * Takes pre-computed publicInputs and proof arrays.
 */
function buildClaimBatchTx(contractAddr: string): string {
  return `
import JanusFT from ${contractAddr}
import EVM from 0x8c5303eaa26202d6

transaction(
  account:      Address,
  publicInputs: [UInt256],
  proof:        [UInt256]
) {
  let registryRef: &JanusFT.CommitmentRegistry
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
      from: JanusFT.CommitmentRegistryStoragePath
    ) ?? panic("claim_batch_ft: signer must hold the JanusFT registry")
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("claim_batch_ft: no COA at /storage/evm")
  }

  execute {
    self.registryRef.claimBatch(
      account:      account,
      publicInputs: publicInputs,
      proof:        proof,
      coa:          self.coa
    )
  }
}
`;
}

/**
 * Publish memoKey to both Cadence storage and EVM MemoKeyRegistry via COA.
 * v0.8: MemoKeyRegistry at 0x361bD4d037838A3a9c5408AE465d36077800ee6c
 */
function buildPublishMemoKeyTx(contractAddr: string): string {
  return `
import JanusFT from ${contractAddr}
import EVM from 0x8c5303eaa26202d6

transaction(memoPubX: UInt256, memoPubY: UInt256) {
  prepare(signer: auth(BorrowValue, IssueStorageCapabilityController, PublishCapability, SaveValue, Storage) &Account) {
    JanusFT.publishMemoKey(account: signer, pubkeyX: memoPubX, pubkeyY: memoPubY)

    let coa = signer.storage
      .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("No COA at /storage/evm")

    let memoRegistryAddr = EVM.addressFromString("0x361bD4d037838A3a9c5408AE465d36077800ee6c")

    let calldata = EVM.encodeABIWithSignature(
      "publishMemoKey(uint256,uint256)",
      [memoPubX, memoPubY]
    )

    let result = coa.call(
      to: memoRegistryAddr,
      data: calldata,
      gasLimit: 100000,
      value: EVM.Balance(attoflow: 0)
    )

    assert(
      result.status == EVM.Status.successful,
      message: "EVM MemoKeyRegistry.publishMemoKey failed: ".concat(result.errorMessage)
    )
  }
}
`;
}

// ---------------------------------------------------------------------------
// Pre-built proof types (for browser callers)
// ---------------------------------------------------------------------------

export interface FTWrapViaCoaPrebuiltProof {
  proof: ProofUint256;
  txCommit: readonly [bigint, bigint];
  blinding: bigint;
  nonce: bigint;
  publicInputs: readonly [bigint, bigint, bigint, bigint];
}

export interface FTShieldedTransferViaCoaPrebuiltProof {
  proof: ProofUint256;
  publicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  transferBlinding: bigint;
  newBlinding: bigint;
}

export interface FTBatchClaimParams {
  /** User's current hidden balance (amount scalar). */
  oldBalance: bigint;
  /** Current Pedersen blinding factor. */
  oldBlinding: bigint;
  /** Fresh blinding for the post-claim commitment. */
  newBlinding: bigint;
  /** Notes to consume from the JanusFT inbox (up to 50). */
  notesToConsume: Array<{ amount: bigint; blinding: bigint }>;
  /** Cadence address of the user (owner of CommitmentRegistry). */
  userCadenceAddr: string;
  /**
   * Optional circuit artifact paths.
   * If omitted, uses the wasm/zkey bundled with the SDK.
   */
  circuitOptions?: BatchClaimProofOptions;
}

export interface FTBatchClaimResult {
  /** Cadence transaction ID. */
  txHash: string;
  /** New on-chain commitment after the claim. */
  newCommit: { x: bigint; y: bigint };
  /** New balance (oldBalance + Σ consumed note amounts). */
  newBalance: bigint;
  /** Public inputs that were submitted. */
  publicInputs: [bigint, bigint, bigint, bigint, bigint, bigint];
}

export interface FTUnwrapViaCoaPrebuiltProofs {
  amountProof: ProofUint256;
  txCommit: readonly [bigint, bigint];
  amountPublicInputs: readonly [bigint, bigint, bigint, bigint];
  transferProof: ProofUint256;
  transferPublicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  newBlinding: bigint;
  nonce: bigint;
}

// ---------------------------------------------------------------------------
// MemoKey registry ABI (EVM read-only)
// ---------------------------------------------------------------------------

const FT_MEMO_REGISTRY_ABI = [
  "function getMemoKey(address) view returns (uint256 x, uint256 y, uint256 publishedAt)",
];

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class JanusFTAdapter implements JanusTokenAdapter {
  readonly id: string;
  readonly variant = "cadence-ft" as const;
  readonly address: string;
  readonly decimals: number;

  private readonly entry: CadenceFTTokenEntry;
  private readonly accessApiUrl: string;
  private readonly provider: ethers.JsonRpcProvider;
  readonly memoRegistryAddress: string;

  constructor(id: string, entry: CadenceFTTokenEntry, accessApiUrl = FLOW_CADENCE_ACCESS, rpcUrl = FLOW_EVM_RPC) {
    this.id = id;
    this.entry = entry;
    this.address = entry.cadenceAddress;
    this.decimals = entry.decimals;
    this.accessApiUrl = accessApiUrl;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.memoRegistryAddress = MEMO_REGISTRY_ADDRESS;
  }

  private _memoRegistry(): ethers.Contract {
    return new ethers.Contract(this.memoRegistryAddress, FT_MEMO_REGISTRY_ABI, this.provider);
  }

  private async _fcl() {
    const fcl = await import("@onflow/fcl");
    fcl.config({ "accessNode.api": this.accessApiUrl });
    return fcl;
  }

  async getBalance(addr: string): Promise<bigint> {
    const fcl = await this._fcl();
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
    const floatVal = parseFloat(result as string);
    return BigInt(Math.round(floatVal * 1e8));
  }

  async getCommitment(addr: string): Promise<Point> {
    const fcl = await this._fcl();
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

  async getMemoKey(addr: string): Promise<{ x: bigint; y: bigint } | null> {
    try {
      const [x, y] = await this._memoRegistry().getMemoKey(addr);
      const xb = BigInt(x);
      const yb = BigInt(y);
      if (xb === 0n && yb === 0n) return null;
      return { x: xb, y: yb };
    } catch {
      return null;
    }
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
    const fcl = await this._fcl();
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
   * Get the Cadence transaction string for installing the JanusFT registry.
   * Pass to fcl.mutate({ cadence, args: () => [] }) to execute.
   */
  buildInstallUserRegistryTx(): string {
    return buildInstallUserRegistryTx(
      this.entry.cadenceAddress,
      this.entry.ftContractName,
      this.entry.ftAddress,
    );
  }

  /** Sign and submit the install-registry transaction via FCL. */
  async installUserRegistry(): Promise<TxResult> {
    const fcl = await this._fcl();
    const cadence = this.buildInstallUserRegistryTx();
    const txId: string = await fcl.mutate({
      cadence,
      args: () => [],
      proposer: fcl.authz,
      payer: fcl.authz,
      authorizations: [fcl.authz],
      limit: 9999,
    });
    await fcl.tx(txId).onceSealed();
    return { txHash: txId };
  }

  async wrap(params: WrapParams, _signer: EVMSigner): Promise<WrapResult> {
    const fcl = await this._fcl();
    const bps = await this.feeBps();
    const signerCadenceAddr = this.entry.cadenceAddress;
    const memoKey = await this.getMemoKey(signerCadenceAddr);
    if (!memoKey) throw new Error("JanusFTAdapter.wrap: signer has no memoKey");
    const orch = await orchestrateWrap({
      grossAmount: params.grossAmount,
      feeBps: bps,
      senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
    });
    const { pA, pB, pC } = splitProofForCadence(orch.amountProof);
    const cadence = buildWrapTx(this.entry.cadenceAddress, this.entry.ftContractName, this.entry.ftAddress);
    const txId: string = await fcl.mutate({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [
        arg(signerCadenceAddr, types.Address),
        arg(rawToUFix64(params.grossAmount), types.UFix64),
        arg(orch.nonce.toString(), types.UInt256),
        arg(orch.txCommit[0].toString(), types.UInt256),
        arg(orch.txCommit[1].toString(), types.UInt256),
        arg(pA.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(pB.map((row) => row.map((v) => v.toString())), types.Array(types.Array(types.UInt256))),
        arg(pC.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(Array.from(orch.encryptedSnapshot).map(String), types.Array(types.UInt8)),
        arg(orch.ephPubkeyX.toString(), types.UInt256),
        arg(orch.ephPubkeyY.toString(), types.UInt256),
      ],
    });
    await fcl.tx(txId).onceSealed();
    return { txHash: txId, netAmount: orch.netAmount, fee: orch.fee };
  }

  async wrapViaCoa(params: WrapParams & {
    coaEvmAddr: string;
    userCadenceAddr: string;
    prebuiltProof: FTWrapViaCoaPrebuiltProof;
  }): Promise<WrapResult> {
    const fcl = await this._fcl();
    const memoKey = await this.getMemoKey(params.coaEvmAddr);
    if (!memoKey) {
      throw new Error(`JanusFTAdapter.wrapViaCoa: COA ${params.coaEvmAddr} has no registered memoKey.`);
    }
    const bps = await this.feeBps();
    const orch = await orchestrateWrapWithPrebuiltProof({
      grossAmount: params.grossAmount,
      feeBps: bps,
      senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
      proof: params.prebuiltProof.proof,
      txCommit: params.prebuiltProof.txCommit,
      blinding: params.prebuiltProof.blinding,
      nonce: params.prebuiltProof.nonce,
      publicInputs: params.prebuiltProof.publicInputs,
    });
    const { pA, pB, pC } = splitProofForCadence(orch.amountProof);
    const cadence = buildWrapTx(this.entry.cadenceAddress, this.entry.ftContractName, this.entry.ftAddress);
    const txId: string = await fcl.mutate({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [
        arg(params.userCadenceAddr, types.Address),
        arg(rawToUFix64(params.grossAmount), types.UFix64),
        arg(orch.nonce.toString(), types.UInt256),
        arg(orch.txCommit[0].toString(), types.UInt256),
        arg(orch.txCommit[1].toString(), types.UInt256),
        arg(pA.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(pB.map((row) => row.map((v) => v.toString())), types.Array(types.Array(types.UInt256))),
        arg(pC.map((v) => v.toString()), types.Array(types.UInt256)),
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
   * shieldedTransfer — v0.8: 7 args (dropped sender snapshot).
   * Returns checkpointPayload for follow-up ShieldedCheckpoint update.
   */
  async shieldedTransfer(params: SendParams, _signer: EVMSigner): Promise<SendResult> {
    const fcl = await this._fcl();
    const signerCadenceAddr = this.entry.cadenceAddress;
    const [senderMemoKey, recipientMemoKey] = await Promise.all([
      this.getMemoKey(signerCadenceAddr),
      this.getMemoKey(params.recipient),
    ]);
    if (!senderMemoKey) throw new Error("JanusFTAdapter.shieldedTransfer: sender has no memoKey");
    if (!recipientMemoKey) {
      throw new Error(`JanusFTAdapter.shieldedTransfer: recipient ${params.recipient} has no memoKey`);
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
        arg(orch.txParams.proof.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.txParams.publicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(Array.from(orch.txParams.encryptedNoteTo).map(String), types.Array(types.UInt8)),
        arg(orch.txParams.ephPubkeyToX.toString(), types.UInt256),
        arg(orch.txParams.ephPubkeyToY.toString(), types.UInt256),
      ],
    });
    await fcl.tx(txId).onceSealed();
    return {
      txHash: txId,
      checkpointPayload: orch.checkpointPayload,
      newBalance: orch.newBalance,
      newBlinding: orch.newBlinding,
    };
  }

  async shieldedTransferViaCoa(params: SendParams & {
    coaEvmAddr: string;
    userCadenceAddr: string;
    prebuiltProof: FTShieldedTransferViaCoaPrebuiltProof;
  }): Promise<SendResult> {
    const fcl = await this._fcl();
    const recipientCoa = await getCoaEvmAddress(params.recipient);
    const [senderMemoKey, recipientMemoKey] = await Promise.all([
      this.getMemoKey(params.coaEvmAddr),
      this.getMemoKey(recipientCoa),
    ]);
    if (!senderMemoKey) {
      throw new Error(`JanusFTAdapter.shieldedTransferViaCoa: no memoKey for COA ${params.coaEvmAddr}`);
    }
    if (!recipientMemoKey) {
      throw new Error(`JanusFTAdapter.shieldedTransferViaCoa: recipient ${params.recipient} (COA ${recipientCoa}) has no memoKey`);
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
    const txId: string = await fcl.mutate({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [
        arg(params.userCadenceAddr, types.Address),
        arg(params.recipient, types.Address),
        arg(orch.txParams.proof.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.txParams.publicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(Array.from(orch.txParams.encryptedNoteTo).map(String), types.Array(types.UInt8)),
        arg(orch.txParams.ephPubkeyToX.toString(), types.UInt256),
        arg(orch.txParams.ephPubkeyToY.toString(), types.UInt256),
      ],
      proposer: fcl.authz,
      payer: fcl.authz,
      authorizations: [fcl.authz],
      limit: 9999,
    });
    await fcl.tx(txId).onceSealed();
    return {
      txHash: txId,
      checkpointPayload: orch.checkpointPayload,
      newBalance: orch.newBalance,
      newBlinding: orch.newBlinding,
    };
  }

  async unwrap(params: UnwrapParams, _signer: EVMSigner): Promise<UnwrapResult> {
    const fcl = await this._fcl();
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
        arg(orch.transferProof.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.transferPublicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(Array.from(orch.encryptedSnapshot).map(String), types.Array(types.UInt8)),
        arg(orch.ephPubkeyX.toString(), types.UInt256),
        arg(orch.ephPubkeyY.toString(), types.UInt256),
      ],
    });
    await fcl.tx(txId).onceSealed();
    return { txHash: txId, netToRecipient: orch.netToRecipient };
  }

  async unwrapViaCoa(params: UnwrapParams & {
    coaEvmAddr: string;
    userCadenceAddr: string;
    prebuiltProofs: FTUnwrapViaCoaPrebuiltProofs;
  }): Promise<UnwrapResult> {
    const fcl = await this._fcl();
    const memoKey = await this.getMemoKey(params.coaEvmAddr);
    if (!memoKey) {
      throw new Error(`JanusFTAdapter.unwrapViaCoa: no memoKey for COA ${params.coaEvmAddr}`);
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
      nonce: params.prebuiltProofs.nonce,
    });
    const cadence = buildUnwrapTx(this.entry.cadenceAddress, this.entry.ftContractName, this.entry.ftAddress);
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

  async decryptNoteTo(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<NoteContent> {
    return decryptNote(blob, ephPub, myMemoPrivKey);
  }

  async decryptSnapshot(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<SnapshotContent> {
    const result = await decryptSnapshot(blob, ephPub, myMemoPrivKey);
    if (result === null) throw new Error("JanusFTAdapter.decryptSnapshot: decryption failed");
    return result;
  }

  /**
   * batchClaimAndUpdate — aggregate ShieldedInbox notes into this user's JanusFT commitment.
   *
   * Cadence path (FCL):
   *   1. Generates a ConfidentialClaimBatch Groth16 proof (N=50) off-chain.
   *   2. Submits a Cadence tx that calls JanusFT.CommitmentRegistry.claimBatch()
   *      with the computed publicInputs and proof.
   *   3. JanusFT calls ConfidentialClaimBatchVerifier via cross-VM.
   *
   * @param params.userCadenceAddr  Cadence address of the user (owner of CommitmentRegistry).
   * @param params.oldBalance       Current hidden balance scalar.
   * @param params.oldBlinding      Current Pedersen blinding factor.
   * @param params.newBlinding      Fresh blinding for the post-claim commitment.
   * @param params.notesToConsume   Up to 50 inbox notes (amount + blinding each).
   */
  async batchClaimAndUpdate(params: FTBatchClaimParams): Promise<FTBatchClaimResult> {
    const fcl = await this._fcl();

    // Generate proof off-chain
    const { publicInputs, proof, newCommit, newBalance } = await buildBatchClaimProof(
      {
        oldBalance: params.oldBalance,
        oldBlinding: params.oldBlinding,
        newBlinding: params.newBlinding,
        notes: params.notesToConsume,
      },
      params.circuitOptions
    );

    const cadence = buildClaimBatchTx(this.entry.cadenceAddress);
    const txId: string = await fcl.mutate({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [
        arg(params.userCadenceAddr, types.Address),
        arg(publicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(proof.map((v) => v.toString()), types.Array(types.UInt256)),
      ],
      proposer: fcl.authz,
      payer: fcl.authz,
      authorizations: [fcl.authz],
      limit: 9999,
    });
    await fcl.tx(txId).onceSealed();

    return { txHash: txId, newCommit, newBalance, publicInputs };
  }
}
