/**
 * adapters/janus-erc20.ts — JanusTokenAdapter for variant="erc20" (v0.7+).
 *
 * Wraps an ERC20 underlying via approve+transferFrom (non-payable wrap).
 * Parameterized by TOKEN_REGISTRY entry — one instance per proxy.
 *
 * v0.7 change: wrap() now calls wrapWithProof() with split pA/pB/pC proof
 * and a nonce for anti-replay protection (aggregate 2-gen Pedersen circuit).
 *
 * wrapWithProof() signature:
 *   wrapWithProof(uint256 amount, uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external
 *
 * GROSS amount is passed as `amount`. SDK computes net and builds proof for net.
 * Caller must pre-approve underlying for grossAmount before calling wrap().
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
import type { ProofUint256 } from "../types/proof";
import type { ERC20TokenEntry } from "../types";
import { FLOW_EVM_RPC, MEMO_REGISTRY_ADDRESS } from "../network/contracts";
import { orchestrateWrap, orchestrateWrapWithPrebuiltProof } from "../orchestration/wrap";
import { splitProof } from "../utils/pi-b-swap";
import { orchestrateShieldedTransfer, orchestrateShieldedTransferWithPrebuiltProof } from "../orchestration/shielded-transfer";
import { orchestrateUnwrap, orchestrateUnwrapWithPrebuiltProofs } from "../orchestration/unwrap";

/**
 * Pre-built proof from a server-side route (browser callers).
 * buildAmountDiscloseProof requires Node.js (wasm/zkey file I/O), so browser
 * callers POST to /api/proof/wrap, receive these fields, and pass them here.
 */
export interface WrapViaCoaPrebuiltProofERC20 {
  proof: ProofUint256;
  txCommit: readonly [bigint, bigint];
  blinding: bigint;
  nonce: bigint;
  /** Public inputs [netAmount, Cx, Cy, nonce] — 4 signals (aggregate circuit). */
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
  /** [claimedAmount, Cx, Cy, nonce] — 4 signals. */
  amountPublicInputs: readonly [bigint, bigint, bigint, bigint];
  transferProof: ProofUint256;
  transferPublicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  newBlinding: bigint;
  nonce: bigint;
}
import { decryptSnapshot } from "../crypto/snapshot-schema";
import { decryptNote } from "../crypto/note-schema";
import { scanIncomingNotes } from "../scan/event-scanner";
import { getLatestSnapshot } from "../scan/latest-snapshot";

const ERC20_JANUS_ABI = [
  "function wrapWithProof(uint256 amount, uint256 nonce, uint256[2] commit, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external",
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  "function feeBps() view returns (uint16)",
  "function feeRecipient() view returns (address)",
  "function firstSnapshotBlock(address) view returns (uint256)",
  "function balanceOfCommitmentXY(address) view returns (uint256, uint256)",
  "function memoRegistry() view returns (address)",
] as const;

/** v0.6.3 — MemoKey operations go directly to the shared registry. */
const MEMO_REGISTRY_ABI = [
  "function publishMemoKey(uint256 x, uint256 y) external",
  "function rotateMemoKey(uint256 newX, uint256 newY) external",
  "function getMemoKey(address user) view returns (uint256 x, uint256 y, uint256 publishedAt)",
] as const;

const ERC20_APPROVE_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
] as const;

export class JanusERC20Adapter implements JanusTokenAdapter {
  readonly id: string;
  readonly variant = "erc20" as const;
  readonly address: string;
  readonly decimals: number;
  readonly underlyingAddress: string;

  private readonly provider: ethers.JsonRpcProvider;
  /** Address of the shared MemoKeyRegistry (defaults to MEMO_REGISTRY_ADDRESS). */
  readonly memoRegistryAddress: string;

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

  /** Read-only handle on the shared MemoKeyRegistry. */
  private _registry(): ethers.Contract {
    return new ethers.Contract(this.memoRegistryAddress, MEMO_REGISTRY_ABI, this.provider);
  }

  /** Read-write handle on the shared MemoKeyRegistry (requires signer). */
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
    // v0.6.3: reads from the shared MemoKeyRegistry, not the per-token mapping.
    const [x, y] = await this._registry().getMemoKey(addr);
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
    // v0.6.3: publishes to the shared MemoKeyRegistry directly (NOT the token proxy).
    // One tx registers the user's key for ALL Janus EVM tokens simultaneously.
    const tx = await this._registryRw(signer).publishMemoKey(
      memoKeypair.pubkey.x,
      memoKeypair.pubkey.y
    );
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
  }

  /** Rotate the caller's BabyJub pubkey in the shared registry. */
  async rotateMemoKey(memoKeypair: BabyJubKeypair, signer: EVMSigner): Promise<TxResult> {
    const tx = await this._registryRw(signer).rotateMemoKey(
      memoKeypair.pubkey.x,
      memoKeypair.pubkey.y
    );
    const receipt = await tx.wait();
    return { txHash: receipt.hash };
  }

  /**
   * Wrap grossAmount into shielded slot.
   * Caller MUST have pre-approved underlying for grossAmount:
   *   await erc20.approve(proxyAddress, grossAmount)
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
   * wrapViaCoa — Flow-Wallet / FCL path.
   *
   * Dispatches a Cadence transaction signed by the user's Flow Wallet.
   * The user's COA (at /storage/evm) is msg.sender for both the ERC20
   * approve() and JanusERC20.wrap() calls, matching the COA address that
   * has the MemoKey registered via smartSetupAccount().
   *
   * Use this method in browser contexts where FCL is available. The original
   * wrap() is kept for non-FCL consumers (CLI, scripts, demos).
   *
   * @param params.coaEvmAddr    User's COA EVM hex address (0x…, 42 chars).
   * @param params.prebuiltProof Optional: pre-built proof from /api/proof/wrap.
   *                              Required in browser — skips Node.js-only proof building.
   */
  async wrapViaCoa(
    params: WrapParams & { coaEvmAddr: string; prebuiltProof?: WrapViaCoaPrebuiltProofERC20 }
  ): Promise<WrapResult> {
    // Dynamic FCL import — only available in browser/FCL environments.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fcl: any = await import("@onflow/fcl");

    const bps = await this.feeBps();

    // Look up the MemoKey registered under the user's COA address.
    const memoKey = await this.getMemoKey(params.coaEvmAddr);
    if (!memoKey) {
      throw new Error(
        `JanusERC20Adapter.wrapViaCoa: COA ${params.coaEvmAddr} has no registered memoKey. Run smartSetupAccount first.`
      );
    }

    // Orchestrate: use pre-built proof if provided (browser path), otherwise build inline.
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

    // ABI-encode approve(proxy, grossAmount) for the underlying ERC20.
    const approveIface = new ethers.Interface(ERC20_APPROVE_ABI);
    const approveCalldata = approveIface.encodeFunctionData("approve", [
      this.address,
      params.grossAmount,
    ]).slice(2); // strip 0x

    // ABI-encode JanusERC20.wrapWithProof(amount, nonce, commit, pA, pB, pC, snapshot, ephX, ephY)
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
    ]).slice(2); // strip 0x

    // Cadence tx: COA calls approve then wrap in a single atomic transaction.
    const cadenceTx = `
import EVM from 0x8c5303eaa26202d6

transaction(approveCalldata: String, wrapCalldata: String, underlyingHex: String, proxyHex: String) {
  prepare(signer: auth(BorrowValue, Storage) &Account) {
    let coa = signer.storage.borrow<auth(EVM.Call, EVM.Owner) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("No COA at /storage/evm — run smartSetupAccount first")

    // 1. Approve proxy to spend underlying ERC20.
    let approveResult = coa.call(
      to: EVM.addressFromString(underlyingHex),
      data: approveCalldata.decodeHex(),
      gasLimit: 100000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(approveResult.status == EVM.Status.successful,
      message: "ERC20.approve reverted — errorCode: ".concat(approveResult.errorCode.toString()).concat(" ").concat(approveResult.errorMessage))

    // 2. Call JanusERC20.wrap.
    let wrapResult = coa.call(
      to: EVM.addressFromString(proxyHex),
      data: wrapCalldata.decodeHex(),
      gasLimit: 800000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(wrapResult.status == EVM.Status.successful,
      message: "JanusERC20.wrap reverted — errorCode: ".concat(wrapResult.errorCode.toString()).concat(" ").concat(wrapResult.errorMessage))
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

  async shieldedTransfer(params: SendParams, signer: EVMSigner): Promise<SendResult> {
    const signerAddr = await signer.getAddress();
    const [senderMemoKey, recipientMemoKey] = await Promise.all([
      this.getMemoKey(signerAddr),
      this.getMemoKey(params.recipient),
    ]);
    if (!senderMemoKey) throw new Error(`JanusERC20Adapter.shieldedTransfer: sender has no memoKey`);
    if (!recipientMemoKey) {
      throw new Error(
        `JanusERC20Adapter.shieldedTransfer: recipient ${params.recipient} has no memoKey`
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

  /**
   * shieldedTransferViaCoa — Flow-Wallet / FCL path for shielded transfers.
   *
   * Dispatches a Cadence transaction that calls JanusERC20.shieldedTransfer via
   * the user's COA. The COA address must match the memoKey registration.
   *
   * @param params.coaEvmAddr        User's COA EVM hex address.
   * @param params.prebuiltProof     Optional: pre-built proof from /api/proof/shielded-transfer.
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
      throw new Error(
        `JanusERC20Adapter.shieldedTransferViaCoa: COA ${params.coaEvmAddr} has no registered memoKey. Run smartSetupAccount first.`
      );
    }
    if (!recipientMemoKey) {
      throw new Error(
        `JanusERC20Adapter.shieldedTransferViaCoa: recipient ${params.recipient} has no memoKey`
      );
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
      [...orch.publicInputs],
      [...orch.proof],
      ethers.hexlify(orch.encryptedSnapshot),
      orch.ephPubkeyX,
      orch.ephPubkeyY,
      ethers.hexlify(orch.encryptedNoteTo),
      orch.ephPubkeyToX,
      orch.ephPubkeyToY,
    ]).slice(2);

    const cadenceTx = `
import EVM from 0x8c5303eaa26202d6

transaction(calldataHex: String, proxyHex: String) {
  prepare(signer: auth(BorrowValue, Storage) &Account) {
    let coa = signer.storage.borrow<auth(EVM.Call, EVM.Owner) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("No COA at /storage/evm — run smartSetupAccount first")

    let result = coa.call(
      to: EVM.addressFromString(proxyHex),
      data: calldataHex.decodeHex(),
      gasLimit: 1000000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(result.status == EVM.Status.successful,
      message: "JanusERC20.shieldedTransfer reverted — errorCode: "
        .concat(result.errorCode.toString())
        .concat(" msg: ").concat(result.errorMessage)
        .concat(" data: 0x").concat(String.encodeHex(result.data)))
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
    return { txHash: txId };
  }

  /**
   * unwrapViaCoa — Flow-Wallet / FCL path for unwrapping ERC20 tokens.
   *
   * Dispatches a Cadence transaction that calls JanusERC20.unwrap via the user's COA.
   *
   * @param params.coaEvmAddr        User's COA EVM hex address.
   * @param params.prebuiltProofs    Optional: pre-built proofs from /api/proof/unwrap.
   */
  async unwrapViaCoa(
    params: UnwrapParams & { coaEvmAddr: string; prebuiltProofs?: UnwrapViaCoaPrebuiltProofsERC20 }
  ): Promise<UnwrapResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fcl: any = await import("@onflow/fcl");

    const bps = await this.feeBps();

    const memoKey = await this.getMemoKey(params.coaEvmAddr);
    if (!memoKey) {
      throw new Error(
        `JanusERC20Adapter.unwrapViaCoa: COA ${params.coaEvmAddr} has no registered memoKey. Run smartSetupAccount first.`
      );
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
    ) ?? panic("No COA at /storage/evm — run smartSetupAccount first")

    let result = coa.call(
      to: EVM.addressFromString(proxyHex),
      data: calldataHex.decodeHex(),
      gasLimit: 1000000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(result.status == EVM.Status.successful,
      message: "JanusERC20.unwrap reverted — errorCode: ".concat(result.errorCode.toString()).concat(" ").concat(result.errorMessage))
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

  async scanDeposits(addr: string, fromBlock?: bigint): Promise<DepositRecord[]> {
    return scanIncomingNotes(addr, this.address, this.provider, fromBlock !== undefined ? { fromBlock } : undefined);
  }

  async decryptNoteTo(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<NoteContent> {
    return decryptNote(blob, ephPub, myMemoPrivKey);
  }

  async decryptSnapshot(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<SnapshotContent> {
    const result = await decryptSnapshot(blob, ephPub, myMemoPrivKey);
    if (result === null) throw new Error("JanusERC20Adapter.decryptSnapshot: decryption failed");
    return result;
  }

  async latestSnapshot(addr: string, myMemoPrivKey: bigint): Promise<SnapshotContent> {
    const snap = await getLatestSnapshot(addr, this.address, this.provider, myMemoPrivKey);
    if (snap === null) throw new Error(`JanusERC20Adapter.latestSnapshot: no snapshot found for ${addr}`);
    return snap;
  }
}
