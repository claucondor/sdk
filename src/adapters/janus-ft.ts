/**
 * adapters/janus-ft.ts — JanusTokenAdapter for variant="cadence-ft" (JanusFT v0.7).
 *
 * Wraps a Cadence FungibleToken vault. Generic wrapper — accepts any underlying
 * FungibleToken configured in JanusFT.custodyVaultType (set at deploy time).
 * For testnet, the underlying is MockFT (0x7599043aea001283). At mainnet, swap to
 * the production FT by updating TOKEN_REGISTRY.mockft.ftAddress.
 *
 * v0.7 aggregate-pedersen changes (deployed 2026-06-05 at 0xc4e8f99915893a2f):
 *   - wrap() now calls wrapWithProof() with split pA/pB/pC + anti-replay nonce
 *   - pA/pB/pC passed in NATURAL SNARKJS ORDER — JanusFT does the pB Fp2-swap internally
 *   - AmountDisclose circuit: 4 public inputs [grossAmount, commitX, commitY, nonce]
 *   - Anti-replay nonces tracked in CommitmentRegistry.usedNonces (per-registry dict)
 *   - Proof circuit: aggregate ceremony zkeys (same as JanusFlow / JanusERC20)
 *
 * UFix64 amounts: raw bigint / 10^8 = UFix64 string for FCL args (UFIX64_SCALE).
 * Addresses: Cadence hex addresses (0x-prefix), not EVM hex.
 *
 * EVM-side reads (memoKey): via shared MemoKeyRegistry at MEMO_REGISTRY_ADDRESS.
 * Cadence-side reads (commitment, balance): via Cadence scripts on JanusFT.
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
import { ethers } from "ethers";
import { FLOW_CADENCE_ACCESS, FLOW_EVM_RPC, MEMO_REGISTRY_ADDRESS, UFIX64_SCALE, PROTOCOL_GENESIS_BLOCK } from "../network/contracts";

const FT_MEMO_REGISTRY_ABI = [
  "function getMemoKey(address) view returns (uint256 x, uint256 y, uint256 publishedAt)",
];
import { orchestrateWrap, orchestrateWrapWithPrebuiltProof } from "../orchestration/wrap";
import { orchestrateShieldedTransfer, orchestrateShieldedTransferWithPrebuiltProof } from "../orchestration/shielded-transfer";
import { orchestrateUnwrap, orchestrateUnwrapWithPrebuiltProofs } from "../orchestration/unwrap";
import { decryptSnapshot } from "../crypto/snapshot-schema";
import { decryptNote } from "../crypto/note-schema";
import {
  scanCadenceSnapshots,
  scanCadenceIncomingNotes,
  findFirstSnapshotBlock,
} from "../scan/cadence-scanner";

// ---------------------------------------------------------------------------
// Proof splitting helpers for Cadence vs EVM paths
// ---------------------------------------------------------------------------

/**
 * Split a ProofUint256 (uint256[8], pB already Fp2-swapped) into the pA/pB/pC
 * triple expected by JanusFT.wrapWithProof. The Cadence contract takes pB in
 * NATURAL SNARKJS ORDER and does the Fp2-swap internally, so we must UN-swap
 * here (reverse what applyPiBSwap did).
 *
 * ProofUint256 layout:
 *   [pA[0], pA[1], pB[0][1], pB[0][0], pB[1][1], pB[1][0], pC[0], pC[1]]
 *   indices 2..5 are pB in EVM (swapped) order.
 *
 * For Cadence we restore natural snarkjs pB order:
 *   pB = [[pi_b[0][0], pi_b[0][1]], [pi_b[1][0], pi_b[1][1]]]
 *       = [[proof[3],  proof[2]],   [proof[5],   proof[4]]]
 */
function splitProofForCadence(proof: ProofUint256 | readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]): {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
} {
  return {
    pA: [proof[0], proof[1]],
    // Reverse the Fp2-swap: proof[2]=pB[0][1], proof[3]=pB[0][0] → natural [proof[3], proof[2]]
    pB: [
      [proof[3], proof[2]],
      [proof[5], proof[4]],
    ],
    pC: [proof[6], proof[7]],
  };
}

// ---------------------------------------------------------------------------
// Cadence transaction templates for JanusFT v0.7 (aggregate-pedersen).
// These templates mirror the production transactions in openjanus-contracts/packages/janus-ft/transactions/.
// The underlying FT (MockFT for testnet) is imported inline where needed.
//
// Proof convention for wrapWithProof:
//   pA/pB/pC are passed in NATURAL SNARKJS ORDER — the Cadence contract does the
//   pB Fp2-swap internally before forwarding to the EVM verifier.
//   shieldedTransfer / unwrap take a flat [UInt256; 8] with pB PRE-SWAPPED (EVM order).

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

/**
 * Build the user_install_janus_ft_registry Cadence transaction.
 *
 * Idempotent — handles three storage states on the signer's account:
 *   A. No resource at path → install fresh CommitmentRegistry.
 *   B. Correct type (current JanusFT.CommitmentRegistry) → no-op, republish cap.
 *   C. Stale resource from a previous JanusFT contract address (e.g. v0.6) →
 *      load as @AnyResource, destroy, install fresh registry.
 *
 * No arguments. Only requires signer permissions (no Admin entitlement).
 * Gas: ~0.00074 FLOW on testnet (measured on bob 2026-06-05).
 *
 * Must be run once before the first MockFT wrap on any account.
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
      // Case A: path empty — install fresh registry
      let emptyVault <- ${ftContractName}.createEmptyVault(vaultType: Type<@${ftContractName}.Vault>())
      let registry   <- JanusFT.createRegistry(vault: <- emptyVault)
      signer.storage.save(<- registry, to: storagePath)
    } else if storedType == Type<@JanusFT.CommitmentRegistry>() {
      // Case B: correct type already present — no-op on storage
    } else {
      // Case C: stale resource from a previous JanusFT contract — destroy and reinstall
      let stale <- signer.storage.load<@AnyResource>(from: storagePath)
        ?? panic("user_install_janus_ft_registry: expected stale resource but load returned nil")
      destroy stale
      let emptyVault <- ${ftContractName}.createEmptyVault(vaultType: Type<@${ftContractName}.Vault>())
      let registry   <- JanusFT.createRegistry(vault: <- emptyVault)
      signer.storage.save(<- registry, to: storagePath)
    }

    // Republish capability (safe to re-issue even if already published)
    signer.capabilities.unpublish(publicPath)
    let cap = signer.capabilities.storage.issue<&{JanusFT.CommitmentRegistryPublic}>(storagePath)
    signer.capabilities.publish(cap, at: publicPath)
  }
}
`;
}

function buildPublishMemoKeyTx(contractAddr: string): string {
  // Publishes the BabyJub memo pubkey to BOTH:
  //   1. Cadence /storage/openjanusMemoKey (shared with JanusFlow.MemoKey — one path, all Cadence tokens)
  //   2. EVM MemoKeyRegistry (0x05D104962ff087441f26BA11A1E1C3b9E091D663) via COA cross-VM call
  //
  // After this single transaction the user's memo key is available from ALL
  // four Janus token adapters (flow/wflow/mockusdc via EVM registry, ft/mockft via Cadence).
  return `
import JanusFT from ${contractAddr}
import JanusFlow from 0x5dcbeb41055ec57e
import EVM from 0x8c5303eaa26202d6

transaction(memoPubX: UInt256, memoPubY: UInt256) {
  prepare(signer: auth(BorrowValue, IssueStorageCapabilityController, PublishCapability, SaveValue, Storage) &Account) {
    JanusFT.publishMemoKey(account: signer, pubkeyX: memoPubX, pubkeyY: memoPubY)
    log("Cadence MemoKey published at /storage/openjanusMemoKey")

    let coa = signer.storage
      .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("No COA at /storage/evm")

    let memoRegistryAddr = EVM.addressFromString("0x05D104962ff087441f26BA11A1E1C3b9E091D663")

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
      message: "EVM MemoKeyRegistry.publishMemoKey failed — errorCode: "
        .concat(result.errorCode.toString())
        .concat(" ")
        .concat(result.errorMessage)
    )
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
  nonce: bigint;
  /** [grossAmount, commitX, commitY, nonce] — 4 signals (aggregate AmountDisclose circuit). */
  publicInputs: readonly [bigint, bigint, bigint, bigint];
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
  /** [claimedAmount, Cx, Cy, nonce] — 4 signals. */
  amountPublicInputs: readonly [bigint, bigint, bigint, bigint];
  transferProof: ProofUint256;
  transferPublicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  newBlinding: bigint;
  nonce: bigint;
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

  /** Read-only handle on the shared EVM MemoKeyRegistry. */
  private _memoRegistry(): ethers.Contract {
    return new ethers.Contract(this.memoRegistryAddress, FT_MEMO_REGISTRY_ABI, this.provider);
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
    // v0.6.6: reads from the shared EVM MemoKeyRegistry. `addr` is the COA's
    // EVM hex address — same registry consumed by JanusFlow / JanusERC20 adapters.
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

  /**
   * Returns the Cadence block height of the user's first JanusFT interaction,
   * using the on-chain FirstSnapshot event as anchor. Falls back to
   * PROTOCOL_GENESIS_BLOCK if no FirstSnapshot event is found (user wrapped
   * before the event was live, i.e. between deploy block and first-live block).
   */
  async getFirstSnapshotBlock(addr: string): Promise<bigint> {
    const { block } = await findFirstSnapshotBlock(
      addr,
      this.entry.cadenceAddress,
      this.entry.contractName,
      { accessApi: this.accessApiUrl }
    );
    return block;
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
   * buildInstallUserRegistryTx — returns the Cadence transaction string that installs
   * (or replaces) the user's JanusFT.CommitmentRegistry.
   *
   * Call this ONCE before the user's first MockFT wrap. The transaction is idempotent:
   *   - Fresh account: installs new registry.
   *   - Already has current registry: no-op on storage, republishes capability.
   *   - Has stale v0.6 registry (wrong contract address): destroys old resource,
   *     installs fresh registry.
   *
   * No arguments required. The returned Cadence string can be passed directly to
   * fcl.mutate({ cadence, args: () => [] }).
   *
   * @example
   *   const adapter = sdk.token('mockft') as JanusFTAdapter;
   *   const cadence = adapter.buildInstallUserRegistryTx();
   *   const txId = await fcl.mutate({
   *     cadence,
   *     args: () => [],
   *     proposer: fcl.authz,
   *     payer: fcl.authz,
   *     authorizations: [fcl.authz],
   *     limit: 9999,
   *   });
   *   await fcl.tx(txId).onceSealed();
   */
  buildInstallUserRegistryTx(): string {
    return buildInstallUserRegistryTx(
      this.entry.cadenceAddress,
      this.entry.ftContractName,
      this.entry.ftAddress,
    );
  }

  /**
   * installUserRegistry — convenience wrapper that signs and submits the
   * install-registry transaction via FCL. Returns the sealed txId.
   *
   * Equivalent to:
   *   const cadence = adapter.buildInstallUserRegistryTx();
   *   const txId = await fcl.mutate({ cadence, args: () => [] });
   *   await fcl.tx(txId).onceSealed();
   */
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
      nonce: params.prebuiltProof.nonce,
      publicInputs: params.prebuiltProof.publicInputs,
    });

    const { pA, pB, pC } = splitProofForCadence(orch.amountProof);
    const cadence = buildWrapTx(this.entry.cadenceAddress, this.entry.ftContractName, this.entry.ftAddress);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      nonce: params.prebuiltProofs.nonce,
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

    // signerCadenceAddr: the FCL-authorized account is the signer. In browser contexts
    // this matches the connected wallet. The adapter uses cadenceAddress as a placeholder
    // for Node.js automation; in production frontends, pass userCadenceAddr via wrapViaCoa.
    const signerCadenceAddr = this.entry.cadenceAddress;

    // Read memoKey from EVM registry — the COA address is the identity used by all Janus adapters.
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
        arg(orch.proof.map((v) => v.toString()), types.Array(types.UInt256)),
        arg(orch.publicInputs.map((v) => v.toString()), types.Array(types.UInt256)),
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

  /**
   * Scan ShieldedTransferWithSnapshot events on JanusFT for incoming notes
   * addressed to `addr`. Uses Flow REST events API.
   *
   * When no `fromBlock` is provided, uses the FirstSnapshot anchor for `addr`
   * (falling back to PROTOCOL_GENESIS_BLOCK if no event is found).
   */
  async scanDeposits(addr: string, fromBlock?: bigint): Promise<DepositRecord[]> {
    let resolvedFromBlock: number;
    if (fromBlock !== undefined) {
      resolvedFromBlock = Number(fromBlock);
    } else {
      const { block } = await findFirstSnapshotBlock(
        addr,
        this.entry.cadenceAddress,
        this.entry.contractName,
        { accessApi: this.accessApiUrl }
      );
      resolvedFromBlock = Number(block);
    }

    const records = await scanCadenceIncomingNotes(
      addr,
      this.entry.cadenceAddress,
      this.entry.contractName,
      { accessApi: this.accessApiUrl, fromBlock: resolvedFromBlock }
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
   *
   * Uses FirstSnapshot event lookup to find the exact per-user scan anchor:
   *   - If a FirstSnapshot event exists: scan from that block forward.
   *   - Otherwise (user wrapped before event was live): scan from
   *     PROTOCOL_GENESIS_BLOCK (v0.7 deploy block) forward as fallback.
   *
   * This eliminates the DEFAULT_LOOKBACK heuristic and guarantees correct
   * recovery regardless of when the user first interacted.
   */
  async latestSnapshot(addr: string, myMemoPrivKey: bigint): Promise<SnapshotContent> {
    const { block: fromBlock, source } = await findFirstSnapshotBlock(
      addr,
      this.entry.cadenceAddress,
      this.entry.contractName,
      { accessApi: this.accessApiUrl }
    );

    const events = await scanCadenceSnapshots(
      addr,
      this.entry.cadenceAddress,
      this.entry.contractName,
      { accessApi: this.accessApiUrl, fromBlock: Number(fromBlock) }
    );

    if (events.length === 0) {
      throw new Error(
        `JanusFTAdapter.latestSnapshot: no snapshot events found for ${addr} ` +
        `(anchor source: ${source}, fromBlock: ${fromBlock})`
      );
    }

    const decoded: SnapshotContent[] = [];
    for (const ev of events) {
      const snap = await decryptSnapshot(ev.ciphertext, ev.ephPubkey, myMemoPrivKey);
      if (snap !== null) decoded.push(snap);
    }
    if (decoded.length === 0) {
      throw new Error(
        `JanusFTAdapter.latestSnapshot: ${events.length} snapshot events found for ${addr} ` +
        `but none decrypted with the supplied memoPrivKey (anchor source: ${source}, fromBlock: ${fromBlock})`
      );
    }
    decoded.sort((a, b) => b.timestampMs - a.timestampMs);
    return decoded[0]!;
  }
}
