/**
 * adapters/janus-erc20.ts — JanusTokenAdapter for variant="erc20" (JanusERC20 v0.8).
 *
 * Wraps an ERC20 underlying via approve+transferFrom (non-payable wrap).
 * Caller MUST pre-approve the underlying for grossAmount before calling wrap().
 *
 * v0.8 ABI surface (proxy at 0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d):
 *   wrapWithProof(uint256 amount, uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)
 *   shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY)
 *   unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY)
 *
 * v0.8 key change: shieldedTransfer is 6-arg (no sender-snapshot calldata).
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
import type { ERC20TokenEntry } from "../types";
import { FLOW_EVM_RPC, MEMO_REGISTRY_ADDRESS } from "../network/contracts";
import { orchestrateWrap, orchestrateWrapWithPrebuiltProof } from "../orchestration/wrap";
import { orchestrateShieldedTransfer, orchestrateShieldedTransferWithPrebuiltProof } from "../orchestration/shielded-transfer";
import { orchestrateUnwrap, orchestrateUnwrapWithPrebuiltProofs } from "../orchestration/unwrap";
import { splitProof } from "../utils/pi-b-swap";
import { decryptNote } from "../crypto/note-helpers";
import { decryptSnapshot } from "../crypto/checkpoint-schema";

// ---------------------------------------------------------------------------
// Pre-built proof types (for browser callers that generate proofs server-side)
// ---------------------------------------------------------------------------

export interface WrapViaCoaPrebuiltProofERC20 {
  proof: ProofUint256;
  txCommit: readonly [bigint, bigint];
  blinding: bigint;
  nonce: bigint;
  publicInputs: readonly [bigint, bigint, bigint, bigint];
}

export interface ShieldedTransferViaCoaPrebuiltProofERC20 {
  proof: ProofUint256;
  publicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  transferBlinding: bigint;
  newBlinding: bigint;
}

export interface UnwrapViaCoaPrebuiltProofsERC20 {
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

const ERC20_JANUS_ABI = [
  // wrap
  "function wrapWithProof(uint256 amount, uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  // transfer — v0.8: 6 args
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external",
  // unwrap
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

const ERC20_APPROVE_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
] as const;

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class JanusERC20Adapter implements JanusTokenAdapter {
  readonly id: string;
  readonly variant = "erc20" as const;
  readonly address: string;
  readonly decimals: number;
  readonly underlyingAddress: string;
  readonly memoRegistryAddress: string;

  private readonly provider: ethers.JsonRpcProvider;

  constructor(id: string, entry: ERC20TokenEntry, rpcUrl = FLOW_EVM_RPC) {
    this.id = id;
    this.address = entry.proxy;
    this.decimals = entry.decimals;
    this.underlyingAddress = entry.underlying;
    this.memoRegistryAddress = MEMO_REGISTRY_ADDRESS;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  private _ro(): ethers.Contract {
    return new ethers.Contract(this.address, ERC20_JANUS_ABI, this.provider);
  }

  private _rw(signer: EVMSigner): ethers.Contract {
    return new ethers.Contract(this.address, ERC20_JANUS_ABI, signer);
  }

  private _registry(): ethers.Contract {
    return new ethers.Contract(this.memoRegistryAddress, MEMO_REGISTRY_ABI, this.provider);
  }

  private _registryRw(signer: EVMSigner): ethers.Contract {
    return new ethers.Contract(this.memoRegistryAddress, MEMO_REGISTRY_ABI, signer);
  }

  async getBalance(addr: string): Promise<bigint> {
    const erc20 = new ethers.Contract(this.underlyingAddress, ERC20_APPROVE_ABI, this.provider);
    const v = await erc20.balanceOf(addr);
    return BigInt(v);
  }

  async getCommitment(addr: string): Promise<Point> {
    const [x, y] = await this._ro().balanceOfCommitmentXY(addr);
    return { x: BigInt(x), y: BigInt(y) };
  }

  async getMemoKey(addr: string): Promise<{ x: bigint; y: bigint } | null> {
    const [x, y] = await this._registry().getMemoKey(addr);
    const xb = BigInt(x);
    const yb = BigInt(y);
    if (xb === 0n && yb === 0n) return null;
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

  /**
   * Approve underlying ERC20 for the proxy contract.
   * Caller must call this before wrap(). Explicit 2-step, matching smoke test pattern.
   */
  async approveUnderlying(amount: bigint, signer: EVMSigner): Promise<TxResult> {
    const erc20 = new ethers.Contract(this.underlyingAddress, ERC20_APPROVE_ABI, signer);
    const tx = await erc20.approve(this.address, amount);
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
  }

  /**
   * Wrap grossAmount into shielded slot.
   * Caller MUST have pre-approved underlying for grossAmount before calling.
   */
  async wrap(params: WrapParams, signer: EVMSigner): Promise<WrapResult> {
    const bps = await this.feeBps();
    const signerAddr = await signer.getAddress();
    const memoKey = await this.getMemoKey(signerAddr);
    if (!memoKey) {
      throw new Error(`JanusERC20Adapter.wrap: signer has no registered memoKey`);
    }
    const orch = await orchestrateWrap({
      grossAmount: params.grossAmount,
      feeBps: bps,
      senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
    });
    const { pA, pB, pC } = splitProof(orch.amountProof);
    const contract = this._rw(signer);
    const tx = await contract.wrapWithProof(
      params.grossAmount,
      orch.nonce,
      [orch.txCommit[0], orch.txCommit[1]],
      pA,
      pB,
      pC,
      ethers.hexlify(orch.encryptedSnapshot),
      orch.ephPubkeyX,
      orch.ephPubkeyY
    );
    const receipt = await tx.wait();
    return { txHash: receipt.hash, netAmount: orch.netAmount, fee: orch.fee };
  }

  /**
   * wrapViaCoa — FCL path. COA calls approve then wrap atomically.
   */
  async wrapViaCoa(
    params: WrapParams & { coaEvmAddr: string; prebuiltProof?: WrapViaCoaPrebuiltProofERC20 }
  ): Promise<WrapResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fcl: any = await import("@onflow/fcl");
    const bps = await this.feeBps();
    const memoKey = await this.getMemoKey(params.coaEvmAddr);
    if (!memoKey) {
      throw new Error(`JanusERC20Adapter.wrapViaCoa: no memoKey for COA ${params.coaEvmAddr}`);
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

    const approveIface = new ethers.Interface(ERC20_APPROVE_ABI);
    const approveCalldata = approveIface.encodeFunctionData("approve", [
      this.address,
      params.grossAmount,
    ]).slice(2);

    const { pA, pB, pC } = splitProof(orch.amountProof);
    const wrapIface = new ethers.Interface(ERC20_JANUS_ABI);
    const wrapCalldata = wrapIface.encodeFunctionData("wrapWithProof", [
      params.grossAmount,
      orch.nonce,
      [orch.txCommit[0], orch.txCommit[1]],
      pA,
      pB,
      pC,
      ethers.hexlify(orch.encryptedSnapshot),
      orch.ephPubkeyX,
      orch.ephPubkeyY,
    ]).slice(2);

    const cadenceTx = `
import EVM from 0x8c5303eaa26202d6

transaction(approveCalldata: String, wrapCalldata: String, underlyingHex: String, proxyHex: String) {
  prepare(signer: auth(BorrowValue, Storage) &Account) {
    let coa = signer.storage.borrow<auth(EVM.Call, EVM.Owner) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("No COA at /storage/evm")
    let approveResult = coa.call(
      to: EVM.addressFromString(underlyingHex),
      data: approveCalldata.decodeHex(),
      gasLimit: 100000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(approveResult.status == EVM.Status.successful,
      message: "ERC20.approve reverted: ".concat(approveResult.errorMessage))
    let wrapResult = coa.call(
      to: EVM.addressFromString(proxyHex),
      data: wrapCalldata.decodeHex(),
      gasLimit: 800000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(wrapResult.status == EVM.Status.successful,
      message: "JanusERC20.wrapWithProof reverted: ".concat(wrapResult.errorMessage))
  }
}
`;
    const txId: string = await fcl.mutate({
      cadence: cadenceTx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, t: any) => [
        arg(approveCalldata, t.String),
        arg(wrapCalldata, t.String),
        arg(this.underlyingAddress, t.String),
        arg(this.address, t.String),
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
   * shieldedTransfer — v0.8 6-arg ABI.
   * Returns checkpointPayload for follow-up ShieldedCheckpoint.update().
   */
  async shieldedTransfer(params: SendParams, signer: EVMSigner): Promise<SendResult> {
    const signerAddr = await signer.getAddress();
    const [senderMemoKey, recipientMemoKey] = await Promise.all([
      this.getMemoKey(signerAddr),
      this.getMemoKey(params.recipient),
    ]);
    if (!senderMemoKey) {
      throw new Error(`JanusERC20Adapter.shieldedTransfer: sender has no memoKey`);
    }
    if (!recipientMemoKey) {
      throw new Error(`JanusERC20Adapter.shieldedTransfer: recipient ${params.recipient} has no memoKey`);
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
    // v0.8 6-arg signature
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
   * shieldedTransferViaCoa — FCL path.
   */
  async shieldedTransferViaCoa(
    params: SendParams & { coaEvmAddr: string; prebuiltProof?: ShieldedTransferViaCoaPrebuiltProofERC20 }
  ): Promise<SendResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fcl: any = await import("@onflow/fcl");
    const [senderMemoKey, recipientMemoKey] = await Promise.all([
      this.getMemoKey(params.coaEvmAddr),
      this.getMemoKey(params.recipient),
    ]);
    if (!senderMemoKey) {
      throw new Error(`JanusERC20Adapter.shieldedTransferViaCoa: no memoKey for COA ${params.coaEvmAddr}`);
    }
    if (!recipientMemoKey) {
      throw new Error(`JanusERC20Adapter.shieldedTransferViaCoa: recipient ${params.recipient} has no memoKey`);
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

    const iface = new ethers.Interface(ERC20_JANUS_ABI);
    const calldata = iface.encodeFunctionData("shieldedTransfer", [
      params.recipient,
      [...orch.txParams.publicInputs],
      [...orch.txParams.proof],
      ethers.hexlify(orch.txParams.encryptedNoteTo),
      orch.txParams.ephPubkeyToX,
      orch.txParams.ephPubkeyToY,
    ]).slice(2);

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
      message: "JanusERC20.shieldedTransfer reverted: ".concat(result.errorMessage))
  }
}
`;
    const txId: string = await fcl.mutate({
      cadence: cadenceTx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, t: any) => [
        arg(calldata, t.String),
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
    if (!memoKey) throw new Error(`JanusERC20Adapter.unwrap: signer has no memoKey`);
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

  async unwrapViaCoa(
    params: UnwrapParams & { coaEvmAddr: string; prebuiltProofs?: UnwrapViaCoaPrebuiltProofsERC20 }
  ): Promise<UnwrapResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fcl: any = await import("@onflow/fcl");
    const bps = await this.feeBps();
    const memoKey = await this.getMemoKey(params.coaEvmAddr);
    if (!memoKey) {
      throw new Error(`JanusERC20Adapter.unwrapViaCoa: no memoKey for COA ${params.coaEvmAddr}`);
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

    const iface = new ethers.Interface(ERC20_JANUS_ABI);
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
    ]).slice(2);

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
      message: "JanusERC20.unwrap reverted: ".concat(result.errorMessage))
  }
}
`;
    const txId: string = await fcl.mutate({
      cadence: cadenceTx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, t: any) => [
        arg(calldata, t.String),
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
    if (result === null) throw new Error("JanusERC20Adapter.decryptSnapshot: decryption failed");
    return result;
  }
}
