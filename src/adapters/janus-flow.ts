/**
 * adapters/janus-flow.ts — JanusTokenAdapter for variant="native" (JanusFlow v0.6.3+).
 *
 * Wraps native FLOW via msg.value. One instance per proxy address.
 * Parameterized by TOKEN_REGISTRY entry — not a separate class per token.
 *
 * v0.6.3 change: MemoKey reads/writes now go through MemoKeyRegistry
 * (MEMO_REGISTRY_ADDRESS), NOT the per-token proxy. publishMemoKey sends
 * a tx to the registry directly. getMemoKey reads from the registry.
 * Tokens become read-only consumers of the registry.
 *
 * ABI surface (v0.6.3 proxy):
 *   wrap(uint256[2] txCommit, uint256[8] amountProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external payable
 *   shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external
 *   unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external
 *   feeBps() view returns (uint16)
 *   feeRecipient() view returns (address)
 *   firstSnapshotBlock(address) view returns (uint256)
 *   balanceOfCommitmentXY(address) view returns (uint256, uint256)
 *   memoRegistry() view returns (address)
 *
 * MemoKeyRegistry ABI (for publishMemoKey / rotateMemoKey / getMemoKey):
 *   publishMemoKey(uint256 x, uint256 y) external
 *   rotateMemoKey(uint256 newX, uint256 newY) external
 *   getMemoKey(address user) view returns (uint256 x, uint256 y, uint256 publishedAt)
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
import type { NativeTokenEntry } from "../types";
import { FLOW_EVM_RPC, MEMO_REGISTRY_ADDRESS } from "../network/contracts";
import { orchestrateWrap, orchestrateWrapWithPrebuiltProof } from "../orchestration/wrap";

/**
 * Pre-built proof from a server-side route (browser callers).
 * buildAmountDiscloseProof requires Node.js (wasm/zkey file I/O), so browser
 * callers POST to /api/proof/wrap, receive these fields, and pass them here.
 */
export interface WrapViaCoaPrebuiltProof {
  /** Groth16 proof as uint256[8] (EVM-ready, pi_b Fp2-swapped). */
  proof: ProofUint256;
  /** Pedersen commitment point from the circuit. */
  txCommit: readonly [bigint, bigint];
  /** Blinding factor generated client-side before the API call. */
  blinding: bigint;
  /** Public inputs [claimed_netAmount, Cx, Cy]. */
  publicInputs: readonly [bigint, bigint, bigint];
}

/**
 * Pre-built ConfidentialTransfer proof for shieldedTransferViaCoa (browser callers).
 * POST to /api/proof/shielded-transfer to get proof + publicInputs.
 */
export interface ShieldedTransferViaCoaPrebuiltProof {
  /** ConfidentialTransfer proof (uint256[8]). */
  proof: ProofUint256;
  /** Public inputs [C_old.x,y, C_tx.x,y, C_new.x,y] (uint256[6]). */
  publicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  /** Transfer blinding (needed for note encryption to recipient). */
  transferBlinding: bigint;
  /** New blinding for residual commitment (needed for snapshot encryption). */
  newBlinding: bigint;
}

/**
 * Pre-built proofs for unwrapViaCoa (browser callers).
 * POST to /api/proof/unwrap to get both proofs.
 */
export interface UnwrapViaCoaPrebuiltProofs {
  /** AmountDisclose proof (uint256[8]) for claimedAmount. */
  amountProof: ProofUint256;
  /** AmountDisclose txCommit [Cx, Cy]. */
  txCommit: readonly [bigint, bigint];
  /** AmountDisclose publicInputs [claimed_amount, Cx, Cy]. */
  amountPublicInputs: readonly [bigint, bigint, bigint];
  /** ConfidentialTransfer proof (uint256[8]) for the residual spend. */
  transferProof: ProofUint256;
  /** ConfidentialTransfer publicInputs [C_old.x,y, C_tx.x,y, C_new.x,y]. */
  transferPublicInputs: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  /** New blinding for residual commitment (needed for snapshot encryption). */
  newBlinding: bigint;
}
import { orchestrateShieldedTransfer, orchestrateShieldedTransferWithPrebuiltProof } from "../orchestration/shielded-transfer";
import { orchestrateUnwrap, orchestrateUnwrapWithPrebuiltProofs } from "../orchestration/unwrap";
import { decryptSnapshot } from "../crypto/snapshot-schema";
import { decryptNote } from "../crypto/note-schema";
import { scanIncomingNotes } from "../scan/event-scanner";
import { getLatestSnapshot } from "../scan/latest-snapshot";

const NATIVE_ABI = [
  "function wrap(uint256[2] txCommit, uint256[8] amountProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external payable",
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

export class JanusFlowAdapter implements JanusTokenAdapter {
  readonly id: string;
  readonly variant = "native" as const;
  readonly address: string;
  readonly decimals: number;
  /** Address of the shared MemoKeyRegistry (defaults to MEMO_REGISTRY_ADDRESS). */
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

  /** Read-only handle on the shared MemoKeyRegistry. */
  private _registry(): ethers.Contract {
    return new ethers.Contract(this.memoRegistryAddress, MEMO_REGISTRY_ABI, this.provider);
  }

  /** Read-write handle on the shared MemoKeyRegistry (requires signer). */
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
    // v0.6.3: reads from the shared MemoKeyRegistry, not the per-token mapping.
    const [x, y, publishedAt] = await this._registry().getMemoKey(addr);
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

  /**
   * wrapViaCoa — Flow-Wallet / FCL path.
   *
   * Dispatches a Cadence transaction signed by the user's Flow Wallet.
   * The user's COA (at /storage/evm) is the msg.sender JanusFlow sees,
   * so the MemoKey registered by smartSetupAccount() is found correctly.
   *
   * Use this method in browser contexts where FCL is available and the
   * user authenticates via Flow Wallet. The original wrap() is kept for
   * non-FCL consumers (CLI, scripts, automation, demos).
   *
   * @param params.grossAmount    Gross FLOW in wei (18 decimals).
   * @param params.coaEvmAddr    User's COA EVM hex address (0x…, 42 chars).
   *                              Used to look up their MemoKey from the registry.
   * @param params.prebuiltProof  Optional: pre-built proof from a server-side API
   *                              route (POST /api/proof/wrap). Required when calling
   *                              from a browser, because buildAmountDiscloseProof
   *                              needs Node.js wasm/zkey file I/O. If omitted, the
   *                              SDK builds the proof inline (Node.js callers only).
   */
  async wrapViaCoa(
    params: WrapParams & { coaEvmAddr: string; prebuiltProof?: WrapViaCoaPrebuiltProof }
  ): Promise<WrapResult> {
    // Dynamic FCL import — only available in browser/FCL environments.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fcl: any = await import("@onflow/fcl");

    const bps = await this.feeBps();

    // Look up the MemoKey registered under the user's COA address.
    const memoKey = await this.getMemoKey(params.coaEvmAddr);
    if (!memoKey) {
      throw new Error(
        `JanusFlowAdapter.wrapViaCoa: COA ${params.coaEvmAddr} has no registered memoKey. Run smartSetupAccount first.`
      );
    }

    // Orchestrate: use pre-built proof if provided (browser path), otherwise
    // build proof inline (Node.js callers — buildAmountDiscloseProof is safe).
    const orch = params.prebuiltProof
      ? await orchestrateWrapWithPrebuiltProof({
          grossAmount: params.grossAmount,
          feeBps: bps,
          senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
          proof: params.prebuiltProof.proof,
          txCommit: params.prebuiltProof.txCommit,
          blinding: params.prebuiltProof.blinding,
          publicInputs: params.prebuiltProof.publicInputs,
        })
      : await orchestrateWrap({
          grossAmount: params.grossAmount,
          feeBps: bps,
          senderMemoKeypair: { privkey: 0n, pubkey: memoKey },
        });

    // ABI-encode the JanusFlow.wrap call as calldata.
    // Signature: wrap(uint256[2],uint256[8],bytes,uint256,uint256)
    const iface = new ethers.Interface(NATIVE_ABI);
    const calldata = iface.encodeFunctionData("wrap", [
      [orch.txCommit[0], orch.txCommit[1]],
      [...orch.amountProof],
      ethers.hexlify(orch.encryptedSnapshot),
      orch.ephPubkeyX,
      orch.ephPubkeyY,
    ]);
    // Strip "0x" for Cadence String arg.
    const calldataHex = calldata.slice(2);

    // grossAmount in attoflow (1 FLOW = 10^18 attoflow). UFix64 string is "N.XXXXXXXX"
    // where N = whole FLOW count and XXXXXXXX is the 8-decimal fraction.
    // attoflow / 10^18 → whole FLOW; (attoflow % 10^18) / 10^10 → 8-decimal fraction.
    const attoflowBig = params.grossAmount;
    const flowScale = 1_000_000_000_000_000_000n; // 10^18 attoflow per FLOW
    const ufixFracScale = 10_000_000_000n;         // 10^10 attoflow per UFix64 fractional unit
    const whole = attoflowBig / flowScale;
    const fracAttoflow = attoflowBig % flowScale;
    const fracUfix64 = fracAttoflow / ufixFracScale;
    const amountUFix64 = `${whole}.${fracUfix64.toString().padStart(8, "0")}`;

    // Cadence tx: withdraw FLOW from vault → deposit into COA → coa.call JanusFlow.wrap
    const cadenceTx = `
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868
import EVM from 0x8c5303eaa26202d6

transaction(amountUFix64: UFix64, calldataHex: String, proxyHex: String, attoflowWei: UInt) {
  prepare(signer: auth(BorrowValue, Storage) &Account) {
    let coa = signer.storage.borrow<auth(EVM.Call, EVM.Owner) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("No COA at /storage/evm — run smartSetupAccount first")

    // Withdraw FLOW from Cadence vault and deposit into COA EVM balance.
    let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
      from: /storage/flowTokenVault
    ) ?? panic("No FlowToken vault at /storage/flowTokenVault")
    let payment <- flowVault.withdraw(amount: amountUFix64) as! @FlowToken.Vault
    coa.deposit(from: <-payment)

    // Call JanusFlow.wrap with msg.value = grossAmount in attoflow.
    let result = coa.call(
      to: EVM.addressFromString(proxyHex),
      data: calldataHex.decodeHex(),
      gasLimit: 800000,
      value: EVM.Balance(attoflow: attoflowWei)
    )
    assert(result.status == EVM.Status.successful,
      message: "JanusFlow.wrap reverted — errorCode: ".concat(result.errorCode.toString()).concat(" ").concat(result.errorMessage))
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

  /**
   * shieldedTransferViaCoa — Flow-Wallet / FCL path for shielded transfers.
   *
   * Dispatches a Cadence transaction that calls JanusFlow.shieldedTransfer via
   * the user's COA. The COA address must match the memoKey registration.
   *
   * @param params.coaEvmAddr         User's COA EVM hex address.
   * @param params.prebuiltProof      Optional: pre-built proof from /api/proof/shielded-transfer.
   *                                  Required in browser — skips Node.js-only proof building.
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
      throw new Error(
        `JanusFlowAdapter.shieldedTransferViaCoa: COA ${params.coaEvmAddr} has no registered memoKey. Run smartSetupAccount first.`
      );
    }
    if (!recipientMemoKey) {
      throw new Error(
        `JanusFlowAdapter.shieldedTransferViaCoa: recipient ${params.recipient} has no memoKey`
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

    const iface = new ethers.Interface(NATIVE_ABI);
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
    ]);
    const calldataHex = calldata.slice(2);

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
      message: "JanusFlow.shieldedTransfer reverted — errorCode: "
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
        arg(calldataHex, t.String),
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
   * unwrapViaCoa — Flow-Wallet / FCL path for unwrapping.
   *
   * Dispatches a Cadence transaction that calls JanusFlow.unwrap via the user's COA.
   * The FLOW is sent from the EVM contract back to the COA, which bridges it to
   * the Cadence vault automatically.
   *
   * @param params.coaEvmAddr          User's COA EVM hex address.
   * @param params.prebuiltProofs      Optional: pre-built proofs from /api/proof/unwrap.
   *                                   Required in browser — skips Node.js-only proof building.
   */
  async unwrapViaCoa(
    params: UnwrapParams & { coaEvmAddr: string; prebuiltProofs?: UnwrapViaCoaPrebuiltProofs }
  ): Promise<UnwrapResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fcl: any = await import("@onflow/fcl");

    const bps = await this.feeBps();

    const memoKey = await this.getMemoKey(params.coaEvmAddr);
    if (!memoKey) {
      throw new Error(
        `JanusFlowAdapter.unwrapViaCoa: COA ${params.coaEvmAddr} has no registered memoKey. Run smartSetupAccount first.`
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
    ) ?? panic("No COA at /storage/evm — run smartSetupAccount first")

    let result = coa.call(
      to: EVM.addressFromString(proxyHex),
      data: calldataHex.decodeHex(),
      gasLimit: 1000000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(result.status == EVM.Status.successful,
      message: "JanusFlow.unwrap reverted — errorCode: ".concat(result.errorCode.toString()).concat(" ").concat(result.errorMessage))
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
