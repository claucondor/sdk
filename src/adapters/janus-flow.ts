/**
 * adapters/janus-flow.ts — JanusTokenAdapter for variant="native" (JanusFlow v0.8).
 *
 * Wraps native FLOW via msg.value. One instance per proxy address.
 *
 * v0.8 ABI surface (proxy at 0xA64340C1d356835A2450306Ffd290Ed52c001Ad3):
 *   wrapWithProof(uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) payable
 *   shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)
 *   unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)
 *   feeBps() view returns (uint16)
 *   feeRecipient() view returns (address)
 *   balanceOfCommitmentXY(address) view returns (uint256, uint256)
 *   memoRegistry() view returns (address)
 *
 * Key v0.8 change: shieldedTransfer is NOW 6-arg (no sender-snapshot calldata).
 * Sender snapshot goes to ShieldedCheckpoint.update() separately.
 * Inbox.deposit() is called INTERNALLY by the token contract — do not call directly.
 */

import { ethers } from "ethers";
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
import type { NativeTokenEntry } from "../types";
import { FLOW_EVM_RPC, MEMO_REGISTRY_ADDRESS } from "../network/contracts";
import { orchestrateWrap, orchestrateWrapWithPrebuiltProof } from "../orchestration/wrap";
import { orchestrateShieldedTransfer, orchestrateShieldedTransferWithPrebuiltProof } from "../orchestration/shielded-transfer";
import { orchestrateUnwrap, orchestrateUnwrapWithPrebuiltProofs } from "../orchestration/unwrap";
import { splitProof } from "../utils/pi-b-swap";
import { decryptNote } from "../crypto/note-helpers";
import { decryptSnapshot } from "../crypto/checkpoint-schema";
import { BatchClaimClient } from "../batchClaim/BatchClaimClient";
import type { BuildAndClaimParams, BuildAndClaimResult } from "../batchClaim/BatchClaimClient";

// ---------------------------------------------------------------------------
// Pre-built proof types (for browser callers that generate proofs server-side)
// ---------------------------------------------------------------------------

export interface WrapViaCoaPrebuiltProof {
  proof: ProofUint256;
  txCommit: readonly [bigint, bigint];
  blinding: bigint;
  nonce: bigint;
  publicInputs: readonly [bigint, bigint, bigint, bigint];
}

export interface ShieldedTransferViaCoaPrebuiltProof {
  proof: ProofUint256;
  publicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  transferBlinding: bigint;
  newBlinding: bigint;
}

export interface UnwrapViaCoaPrebuiltProofs {
  amountProof: ProofUint256;
  txCommit: readonly [bigint, bigint];
  amountPublicInputs: readonly [bigint, bigint, bigint, bigint];
  transferProof: ProofUint256;
  transferPublicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  newBlinding: bigint;
  nonce: bigint;
}

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

const NATIVE_ABI = [
  // wrap — payable, nonce-based anti-replay
  "function wrapWithProof(uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external payable",
  // transfer — v0.8: 6 args (no sender snapshot)
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external",
  // unwrap — snapshot still included (senderʼs residual after claiming)
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  // view
  "function feeBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
  "function balanceOfCommitmentXY(address) view returns (uint256, uint256)",
  "function memoRegistry() view returns (address)",
] as const;

const MEMO_REGISTRY_ABI = [
  "function publishMemoKey(uint256 x, uint256 y) external",
  "function rotateMemoKey(uint256 newX, uint256 newY) external",
  "function getMemoKey(address user) view returns (uint256 x, uint256 y, uint256 publishedAt)",
] as const;

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class JanusFlowAdapter implements JanusTokenAdapter {
  readonly id: string;
  readonly variant = "native" as const;
  readonly address: string;
  readonly decimals: number;
  readonly memoRegistryAddress: string;

  private readonly provider: ethers.JsonRpcProvider;

  constructor(id: string, entry: NativeTokenEntry, rpcUrl = FLOW_EVM_RPC) {
    this.id = id;
    this.address = entry.proxy;
    this.decimals = entry.decimals;
    this.memoRegistryAddress = MEMO_REGISTRY_ADDRESS;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  private _ro(): ethers.Contract {
    return new ethers.Contract(this.address, NATIVE_ABI, this.provider);
  }

  private _rw(signer: EVMSigner): ethers.Contract {
    return new ethers.Contract(this.address, NATIVE_ABI, signer);
  }

  private _registry(): ethers.Contract {
    return new ethers.Contract(this.memoRegistryAddress, MEMO_REGISTRY_ABI, this.provider);
  }

  private _registryRw(signer: EVMSigner): ethers.Contract {
    return new ethers.Contract(this.memoRegistryAddress, MEMO_REGISTRY_ABI, signer);
  }

  async getBalance(addr: string): Promise<bigint> {
    return this.provider.getBalance(addr);
  }

  async getCommitment(addr: string): Promise<Point> {
    const [x, y] = await this._ro().balanceOfCommitmentXY(addr);
    return { x: BigInt(x), y: BigInt(y) };
  }

  async getMemoKey(addr: string): Promise<{ x: bigint; y: bigint } | null> {
    const [x, y, publishedAt] = await this._registry().getMemoKey(addr);
    const xb = BigInt(x);
    const yb = BigInt(y);
    if (xb === 0n && yb === 0n) return null;
    void publishedAt;
    return { x: xb, y: yb };
  }

  async feeBps(): Promise<number> {
    const v = await this._ro().feeBps();
    return Number(v);
  }

  async feeRecipient(): Promise<string> {
    return await this._ro().feeRecipient();
  }

  async computeNet(gross: bigint): Promise<bigint> {
    const bps = await this.feeBps();
    if (bps === 0) return gross;
    return gross - (gross * BigInt(bps)) / 10000n;
  }

  async publishMemoKey(memoKeypair: BabyJubKeypair, signer: EVMSigner): Promise<TxResult> {
    const tx = await this._registryRw(signer).publishMemoKey(
      memoKeypair.pubkey.x,
      memoKeypair.pubkey.y
    );
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
  }

  async rotateMemoKey(memoKeypair: BabyJubKeypair, signer: EVMSigner): Promise<TxResult> {
    const tx = await this._registryRw(signer).rotateMemoKey(
      memoKeypair.pubkey.x,
      memoKeypair.pubkey.y
    );
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
  }

  async wrap(params: WrapParams, signer: EVMSigner): Promise<WrapResult> {
    const bps = await this.feeBps();
    const signerAddr = await signer.getAddress();
    const memoKey = await this.getMemoKey(signerAddr);
    if (!memoKey) {
      throw new Error(
        `JanusFlowAdapter.wrap: signer ${signerAddr} has no registered memoKey. Call publishMemoKey first.`
      );
    }
    const orch = await orchestrateWrap({
      grossAmount: params.grossAmount,
      feeBps: bps,
      senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
    });

    const { pA, pB, pC } = splitProof(orch.amountProof);
    const contract = this._rw(signer);
    const tx = await contract.wrapWithProof(
      orch.nonce,
      [orch.txCommit[0], orch.txCommit[1]],
      pA,
      pB,
      pC,
      ethers.hexlify(orch.encryptedSnapshot),
      orch.ephPubkeyX,
      orch.ephPubkeyY,
      { value: params.grossAmount }
    );
    const receipt = await tx.wait();
    return { txHash: receipt.hash, netAmount: orch.netAmount, fee: orch.fee };
  }

  /**
   * wrapViaCoa — Flow-Wallet / FCL path for wrap.
   * Dispatches a Cadence transaction via the user's COA.
   */
  async wrapViaCoa(
    params: WrapParams & { coaEvmAddr: string; prebuiltProof?: WrapViaCoaPrebuiltProof }
  ): Promise<WrapResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fcl: any = await import("@onflow/fcl");
    const bps = await this.feeBps();
    const memoKey = await this.getMemoKey(params.coaEvmAddr);
    if (!memoKey) {
      throw new Error(
        `JanusFlowAdapter.wrapViaCoa: COA ${params.coaEvmAddr} has no registered memoKey.`
      );
    }
    const orch = params.prebuiltProof
      ? await orchestrateWrapWithPrebuiltProof({
          grossAmount: params.grossAmount,
          feeBps: bps,
          senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
          proof: params.prebuiltProof.proof,
          txCommit: params.prebuiltProof.txCommit,
          blinding: params.prebuiltProof.blinding,
          nonce: params.prebuiltProof.nonce,
          publicInputs: params.prebuiltProof.publicInputs,
        })
      : await orchestrateWrap({
          grossAmount: params.grossAmount,
          feeBps: bps,
          senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
        });

    const { pA, pB, pC } = splitProof(orch.amountProof);
    const iface = new ethers.Interface(NATIVE_ABI);
    const calldata = iface.encodeFunctionData("wrapWithProof", [
      orch.nonce,
      [orch.txCommit[0], orch.txCommit[1]],
      pA,
      pB,
      pC,
      ethers.hexlify(orch.encryptedSnapshot),
      orch.ephPubkeyX,
      orch.ephPubkeyY,
    ]);
    const calldataHex = calldata.slice(2);

    const attoflowBig = params.grossAmount;
    const flowScale = 1_000_000_000_000_000_000n;
    const ufixFracScale = 10_000_000_000n;
    const whole = attoflowBig / flowScale;
    const fracAttoflow = attoflowBig % flowScale;
    const fracUfix64 = fracAttoflow / ufixFracScale;
    const amountUFix64 = `${whole}.${fracUfix64.toString().padStart(8, "0")}`;

    const cadenceTx = `
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868
import EVM from 0x8c5303eaa26202d6

transaction(amountUFix64: UFix64, calldataHex: String, proxyHex: String, attoflowWei: UInt) {
  prepare(signer: auth(BorrowValue, Storage) &Account) {
    let coa = signer.storage.borrow<auth(EVM.Call, EVM.Owner) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("No COA at /storage/evm — run setup_coa first")
    let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
      from: /storage/flowTokenVault
    ) ?? panic("No FlowToken vault")
    let payment <- flowVault.withdraw(amount: amountUFix64) as! @FlowToken.Vault
    coa.deposit(from: <-payment)
    let result = coa.call(
      to: EVM.addressFromString(proxyHex),
      data: calldataHex.decodeHex(),
      gasLimit: 800000,
      value: EVM.Balance(attoflow: attoflowWei)
    )
    assert(result.status == EVM.Status.successful,
      message: "JanusFlow.wrapWithProof reverted: ".concat(result.errorMessage))
  }
}
`;
    const txId: string = await fcl.mutate({
      cadence: cadenceTx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, t: any) => [
        arg(amountUFix64, t.UFix64),
        arg(calldataHex, t.String),
        arg(this.address, t.String),
        arg(attoflowBig.toString(), t.UInt),
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
   * shieldedTransfer — v0.8 6-arg ABI (no sender snapshot in calldata).
   * Returns checkpointPayload so caller can update ShieldedCheckpoint separately.
   */
  async shieldedTransfer(params: SendParams, signer: EVMSigner): Promise<SendResult> {
    const signerAddr = await signer.getAddress();
    const [senderMemoKey, recipientMemoKey] = await Promise.all([
      this.getMemoKey(signerAddr),
      this.getMemoKey(params.recipient),
    ]);
    if (!senderMemoKey) {
      throw new Error(`JanusFlowAdapter.shieldedTransfer: sender ${signerAddr} has no memoKey`);
    }
    if (!recipientMemoKey) {
      throw new Error(
        `JanusFlowAdapter.shieldedTransfer: recipient ${params.recipient} has no memoKey`
      );
    }
    const orch = await orchestrateShieldedTransfer({
      currentBalance: params.currentBalance,
      currentBlinding: params.currentBlinding,
      transferAmount: params.amount,
      senderMemoKeypair: { privkey: 0n, pubkey: senderMemoKey },
      recipientMemoKey,
      memo: params.memo,
    });

    const contract = this._rw(signer);
    // 6-arg v0.8 signature
    const tx = await contract.shieldedTransfer(
      params.recipient,
      [...orch.txParams.publicInputs],
      [...orch.txParams.proof],
      ethers.hexlify(orch.txParams.encryptedNoteTo),
      orch.txParams.ephPubkeyToX,
      orch.txParams.ephPubkeyToY
    );
    const receipt = await tx.wait();
    return {
      txHash: receipt.hash,
      checkpointPayload: orch.checkpointPayload,
      newBalance: orch.newBalance,
      newBlinding: orch.newBlinding,
    };
  }

  /**
   * shieldedTransferViaCoa — FCL path (COA is msg.sender).
   * Returns checkpointPayload for a follow-up ShieldedCheckpoint.update().
   */
  async shieldedTransferViaCoa(
    params: SendParams & { coaEvmAddr: string; prebuiltProof?: ShieldedTransferViaCoaPrebuiltProof }
  ): Promise<SendResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fcl: any = await import("@onflow/fcl");
    const [senderMemoKey, recipientMemoKey] = await Promise.all([
      this.getMemoKey(params.coaEvmAddr),
      this.getMemoKey(params.recipient),
    ]);
    if (!senderMemoKey) {
      throw new Error(`JanusFlowAdapter.shieldedTransferViaCoa: no memoKey for COA ${params.coaEvmAddr}`);
    }
    if (!recipientMemoKey) {
      throw new Error(`JanusFlowAdapter.shieldedTransferViaCoa: recipient ${params.recipient} has no memoKey`);
    }
    const orch = params.prebuiltProof
      ? await orchestrateShieldedTransferWithPrebuiltProof({
          currentBalance: params.currentBalance,
          transferAmount: params.amount,
          senderMemoKeypair: { privkey: 0n, pubkey: senderMemoKey },
          recipientMemoKey,
          memo: params.memo,
          proof: params.prebuiltProof.proof,
          publicInputs: params.prebuiltProof.publicInputs,
          transferBlinding: params.prebuiltProof.transferBlinding,
          newBlinding: params.prebuiltProof.newBlinding,
        })
      : await orchestrateShieldedTransfer({
          currentBalance: params.currentBalance,
          currentBlinding: params.currentBlinding,
          transferAmount: params.amount,
          senderMemoKeypair: { privkey: 0n, pubkey: senderMemoKey },
          recipientMemoKey,
          memo: params.memo,
        });

    const iface = new ethers.Interface(NATIVE_ABI);
    const calldata = iface.encodeFunctionData("shieldedTransfer", [
      params.recipient,
      [...orch.txParams.publicInputs],
      [...orch.txParams.proof],
      ethers.hexlify(orch.txParams.encryptedNoteTo),
      orch.txParams.ephPubkeyToX,
      orch.txParams.ephPubkeyToY,
    ]);
    const calldataHex = calldata.slice(2);

    const cadenceTx = `
import EVM from 0x8c5303eaa26202d6

transaction(calldataHex: String, proxyHex: String) {
  prepare(signer: auth(BorrowValue, Storage) &Account) {
    let coa = signer.storage.borrow<auth(EVM.Call, EVM.Owner) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("No COA at /storage/evm")
    let result = coa.call(
      to: EVM.addressFromString(proxyHex),
      data: calldataHex.decodeHex(),
      gasLimit: 1000000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(result.status == EVM.Status.successful,
      message: "JanusFlow.shieldedTransfer reverted: ".concat(result.errorMessage))
  }
}
`;
    const txId: string = await fcl.mutate({
      cadence: cadenceTx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, t: any) => [
        arg(calldataHex, t.String),
        arg(this.address, t.String),
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

  async unwrap(params: UnwrapParams, signer: EVMSigner): Promise<UnwrapResult> {
    const signerAddr = await signer.getAddress();
    const bps = await this.feeBps();
    const memoKey = await this.getMemoKey(signerAddr);
    if (!memoKey) {
      throw new Error(`JanusFlowAdapter.unwrap: signer has no memoKey`);
    }
    const orch = await orchestrateUnwrap({
      claimedAmount: params.claimedAmount,
      feeBps: bps,
      currentBalance: params.currentBalance,
      currentBlinding: params.currentBlinding,
      senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
    });

    const contract = this._rw(signer);
    const tx = await contract.unwrap(
      orch.claimedAmount,
      params.recipient,
      [orch.txCommit[0], orch.txCommit[1]],
      [...orch.amountProof],
      [...orch.transferPublicInputs],
      [...orch.transferProof],
      ethers.hexlify(orch.encryptedSnapshot),
      orch.ephPubkeyX,
      orch.ephPubkeyY
    );
    const receipt = await tx.wait();
    return { txHash: receipt.hash, netToRecipient: orch.netToRecipient };
  }

  /**
   * unwrapViaCoa — FCL path for unwrap.
   */
  async unwrapViaCoa(
    params: UnwrapParams & { coaEvmAddr: string; prebuiltProofs?: UnwrapViaCoaPrebuiltProofs }
  ): Promise<UnwrapResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fcl: any = await import("@onflow/fcl");
    const bps = await this.feeBps();
    const memoKey = await this.getMemoKey(params.coaEvmAddr);
    if (!memoKey) {
      throw new Error(`JanusFlowAdapter.unwrapViaCoa: no memoKey for COA ${params.coaEvmAddr}`);
    }
    const orch = params.prebuiltProofs
      ? await orchestrateUnwrapWithPrebuiltProofs({
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
        })
      : await orchestrateUnwrap({
          claimedAmount: params.claimedAmount,
          feeBps: bps,
          currentBalance: params.currentBalance,
          currentBlinding: params.currentBlinding,
          senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
        });

    const iface = new ethers.Interface(NATIVE_ABI);
    const calldata = iface.encodeFunctionData("unwrap", [
      orch.claimedAmount,
      params.recipient,
      [orch.txCommit[0], orch.txCommit[1]],
      [...orch.amountProof],
      [...orch.transferPublicInputs],
      [...orch.transferProof],
      ethers.hexlify(orch.encryptedSnapshot),
      orch.ephPubkeyX,
      orch.ephPubkeyY,
    ]);
    const calldataHex = calldata.slice(2);

    const cadenceTx = `
import EVM from 0x8c5303eaa26202d6

transaction(calldataHex: String, proxyHex: String) {
  prepare(signer: auth(BorrowValue, Storage) &Account) {
    let coa = signer.storage.borrow<auth(EVM.Call, EVM.Owner) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("No COA at /storage/evm")
    let result = coa.call(
      to: EVM.addressFromString(proxyHex),
      data: calldataHex.decodeHex(),
      gasLimit: 1000000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(result.status == EVM.Status.successful,
      message: "JanusFlow.unwrap reverted: ".concat(result.errorMessage))
  }
}
`;
    const txId: string = await fcl.mutate({
      cadence: cadenceTx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, t: any) => [
        arg(calldataHex, t.String),
        arg(this.address, t.String),
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
    if (result === null) throw new Error("JanusFlowAdapter.decryptSnapshot: decryption failed");
    return result;
  }

  /**
   * batchClaimAndUpdate — aggregate ShieldedInbox notes into this user's shielded balance.
   *
   * Internally calls BatchClaimClient.buildAndClaim():
   *   1. Generates a ConfidentialClaimBatch Groth16 proof (N=50).
   *   2. Submits JanusToken.claimBatch(publicInputs, proof) on-chain.
   *   3. Returns the confirmed receipt and the new commitment.
   *
   * @param params.oldBalance       Current hidden balance scalar.
   * @param params.oldBlinding      Current Pedersen blinding factor.
   * @param params.newBlinding      Fresh blinding for the post-claim commitment.
   * @param params.notesToConsume   Up to 50 inbox notes (amount + blinding each).
   * @param signer                  EVM signer (msg.sender of claimBatch).
   */
  async batchClaimAndUpdate(
    params: BuildAndClaimParams,
    signer: EVMSigner
  ): Promise<BuildAndClaimResult> {
    const client = new BatchClaimClient(signer, this.address);
    return client.buildAndClaim(params);
  }
}
