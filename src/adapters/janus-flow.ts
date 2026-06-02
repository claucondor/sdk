/**
 * adapters/janus-flow.ts — JanusTokenAdapter for variant="native" (JanusFlow, JanusFlow_v0_6).
 *
 * Wraps native FLOW via msg.value. One instance per proxy address.
 * Parameterized by TOKEN_REGISTRY entry — not a separate class per token.
 *
 * ABI surface (v0.6):
 *   wrap(uint256[2] txCommit, uint256[8] amountProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external payable
 *   shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external
 *   unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external
 *   publishMemoKey(uint256 pubkeyX, uint256 pubkeyY) external
 *   memoKeyPubX(address) view returns (uint256)
 *   memoKeyPubY(address) view returns (uint256)
 *   feeBps() view returns (uint16)
 *   feeRecipient() view returns (address)
 *   firstSnapshotBlock(address) view returns (uint256)
 *   balanceOfCommitmentXY(address) view returns (uint256, uint256)
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
  DepositRecord,
  NoteContent,
  SnapshotContent,
} from "../types";
import type { Point } from "../types/commitment";
import type { NativeTokenEntry } from "../types";
import { FLOW_EVM_RPC } from "../network/contracts";
import { orchestrateWrap } from "../orchestration/wrap";
import { orchestrateShieldedTransfer } from "../orchestration/shielded-transfer";
import { orchestrateUnwrap } from "../orchestration/unwrap";
import { decryptSnapshot } from "../crypto/snapshot-schema";
import { decryptNote } from "../crypto/note-schema";
import { scanIncomingNotes } from "../scan/event-scanner";
import { getLatestSnapshot } from "../scan/latest-snapshot";

const NATIVE_ABI = [
  "function wrap(uint256[2] txCommit, uint256[8] amountProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external payable",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external",
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  "function publishMemoKey(uint256 pubkeyX, uint256 pubkeyY) external",
  "function memoKeyPubX(address) view returns (uint256)",
  "function memoKeyPubY(address) view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
  "function firstSnapshotBlock(address) view returns (uint256)",
  "function balanceOfCommitmentXY(address) view returns (uint256, uint256)",
] as const;

export class JanusFlowAdapter implements JanusTokenAdapter {
  readonly id: string;
  readonly variant = "native" as const;
  readonly address: string;
  readonly decimals: number;

  private readonly provider: ethers.JsonRpcProvider;

  constructor(id: string, entry: NativeTokenEntry, rpcUrl = FLOW_EVM_RPC) {
    this.id = id;
    this.address = entry.proxy;
    this.decimals = entry.decimals;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  private _ro(): ethers.Contract {
    return new ethers.Contract(this.address, NATIVE_ABI, this.provider);
  }

  private _rw(signer: EVMSigner): ethers.Contract {
    return new ethers.Contract(this.address, NATIVE_ABI, signer);
  }

  async getBalance(addr: string): Promise<bigint> {
    return this.provider.getBalance(addr);
  }

  async getCommitment(addr: string): Promise<Point> {
    const [x, y] = await this._ro().balanceOfCommitmentXY(addr);
    return { x: BigInt(x), y: BigInt(y) };
  }

  async getMemoKey(addr: string): Promise<{ x: bigint; y: bigint } | null> {
    const [x, y] = await Promise.all([
      this._ro().memoKeyPubX(addr),
      this._ro().memoKeyPubY(addr),
    ]);
    const xb = BigInt(x);
    const yb = BigInt(y);
    if (xb === 0n && yb === 0n) return null;
    return { x: xb, y: yb };
  }

  async getFirstSnapshotBlock(addr: string): Promise<bigint> {
    const v = await this._ro().firstSnapshotBlock(addr);
    return BigInt(v);
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
    const tx = await this._rw(signer).publishMemoKey(
      memoKeypair.pubkey.x,
      memoKeypair.pubkey.y
    );
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
  }

  async wrap(params: WrapParams, signer: EVMSigner): Promise<WrapResult> {
    const bps = await this.feeBps();
    // We need the sender's memokey to encrypt the snapshot — read from chain
    const signerAddr = await signer.getAddress();
    const memoKey = await this.getMemoKey(signerAddr);
    if (!memoKey) {
      throw new Error(
        `JanusFlowAdapter.wrap: signer ${signerAddr} has no registered memoKey. Call publishMemoKey first.`
      );
    }
    // Orchestrate: gross→net→proof→encrypt snapshot
    // We pass a minimal keypair shape (pubkey only needed for snapshot encryption)
    const orch = await orchestrateWrap({
      grossAmount: params.grossAmount,
      feeBps: bps,
      senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
    });

    const contract = this._rw(signer);
    const tx = await contract.wrap(
      [orch.txCommit[0], orch.txCommit[1]],
      [...orch.amountProof],
      ethers.hexlify(orch.encryptedSnapshot),
      orch.ephPubkeyX,
      orch.ephPubkeyY,
      { value: params.grossAmount }
    );
    const receipt = await tx.wait();
    return { txHash: receipt.hash, netAmount: orch.netAmount, fee: orch.fee };
  }

  async shieldedTransfer(params: SendParams, signer: EVMSigner): Promise<SendResult> {
    const signerAddr = await signer.getAddress();
    const [senderMemoKey, recipientMemoKey] = await Promise.all([
      this.getMemoKey(signerAddr),
      this.getMemoKey(params.recipient),
    ]);
    if (!senderMemoKey) {
      throw new Error(`JanusFlowAdapter.shieldedTransfer: sender has no memoKey`);
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
    const tx = await contract.shieldedTransfer(
      params.recipient,
      [...orch.publicInputs],
      [...orch.proof],
      ethers.hexlify(orch.encryptedSnapshot),
      orch.ephPubkeyX,
      orch.ephPubkeyY,
      ethers.hexlify(orch.encryptedNoteTo),
      orch.ephPubkeyToX,
      orch.ephPubkeyToY
    );
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
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

  async scanDeposits(addr: string, fromBlock?: bigint): Promise<DepositRecord[]> {
    return scanIncomingNotes(addr, this.address, this.provider, fromBlock !== undefined ? { fromBlock } : undefined);
  }

  async decryptNoteTo(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<NoteContent> {
    return decryptNote(blob, ephPub, myMemoPrivKey);
  }

  async decryptSnapshot(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<SnapshotContent> {
    const result = await decryptSnapshot(blob, ephPub, myMemoPrivKey);
    if (result === null) throw new Error("JanusFlowAdapter.decryptSnapshot: decryption failed");
    return result;
  }

  async latestSnapshot(addr: string, myMemoPrivKey: bigint): Promise<SnapshotContent> {
    const snap = await getLatestSnapshot(addr, this.address, this.provider, myMemoPrivKey);
    if (snap === null) {
      throw new Error(
        `JanusFlowAdapter.latestSnapshot: no valid snapshot found for ${addr}`
      );
    }
    return snap;
  }
}
