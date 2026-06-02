/**
 * adapters/janus-ft.ts — JanusTokenAdapter for variant="cadence-ft" (JanusMockFT).
 *
 * Wraps a Cadence FungibleToken vault. Orchestration logic is identical to EVM
 * variants, but transaction submission goes through FCL and the Cadence
 * transaction templates.
 *
 * Key differences from EVM adapters:
 *   - wrap() signature has BOTH grossAmount and netAmount (explicit safety check)
 *   - Proofs use v0.3 circuit ceremony zkeys (same as EVM — shared ceremonies)
 *   - Proof packing: applyPiBSwap REQUIRED for Cadence's _verifyGroth16 call
 *   - UFix64 amounts: divide by 10^8 to get UFix64 string for FCL args
 *   - Addresses are Cadence hex addresses (0x7-prefix), not EVM hex
 *
 * Selector trap: Cadence's cross-VM calldata for EVM selectors uses CANONICAL
 * uint256[N] form (not uint[N]). The deployed JanusMockFT hardcodes the correct
 * selectors. The SDK does NOT build cross-VM calldata here — it calls Cadence
 * transactions directly which handle the selector internally.
 *
 * EVM-side reads (commitment, memoKey): JanusMockFT mirrors these to an EVM
 * helper or we read from Cadence scripts. This adapter reads from Cadence scripts.
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
import type { CadenceFTTokenEntry } from "../types";
import { FLOW_CADENCE_ACCESS, UFIX64_SCALE } from "../network/contracts";
import { orchestrateWrap } from "../orchestration/wrap";
import { orchestrateShieldedTransfer } from "../orchestration/shielded-transfer";
import { orchestrateUnwrap } from "../orchestration/unwrap";
import { decryptSnapshot } from "../crypto/snapshot-schema";
import { decryptNote } from "../crypto/note-schema";

// Cadence transaction templates for JanusMockFT v0.6
// These templates use the contract at the configured cadenceAddress

function buildWrapTx(contractAddr: string): string {
  return `
import JanusMockFT from ${contractAddr}

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
  prepare(signer: auth(BorrowValue) &Account) {
    JanusMockFT.wrap(
      signer: signer,
      registryAddr: registryAddr,
      grossAmount: grossAmount,
      netAmount: netAmount,
      txCommit: JanusMockFT.Commitment(x: txCommitX, y: txCommitY),
      amountProof: amountProof,
      amountPublicInputs: amountPublicInputs,
      encryptedSnapshot: encryptedSnapshot,
      ephPubX: ephPubX,
      ephPubY: ephPubY
    )
  }
}
`;
}

function buildShieldedTransferTx(contractAddr: string): string {
  return `
import JanusMockFT from ${contractAddr}

transaction(
  registryAddr: Address,
  recipient: Address,
  publicInputs: [UInt256],
  proof: [UInt256],
  encryptedSnapshot: [UInt8], ephPubX: UInt256, ephPubY: UInt256,
  encryptedNoteTo: [UInt8], ephPubToX: UInt256, ephPubToY: UInt256
) {
  prepare(signer: auth(BorrowValue) &Account) {
    JanusMockFT.shieldedTransfer(
      signer: signer,
      registryAddr: registryAddr,
      recipient: recipient,
      publicInputs: publicInputs,
      proof: proof,
      encryptedSnapshot: encryptedSnapshot,
      ephPubX: ephPubX,
      ephPubY: ephPubY,
      encryptedNoteTo: encryptedNoteTo,
      ephPubToX: ephPubToX,
      ephPubToY: ephPubToY
    )
  }
}
`;
}

function buildUnwrapTx(contractAddr: string): string {
  return `
import JanusMockFT from ${contractAddr}

transaction(
  accountAddress: Address,
  claimedAmount: UFix64,
  recipient: Address,
  txCommitX: UInt256, txCommitY: UInt256,
  amountProof: [UInt256],
  amountPublicInputs: [UInt256],
  transferPublicInputs: [UInt256],
  transferProof: [UInt256],
  encryptedSnapshot: [UInt8], ephPubX: UInt256, ephPubY: UInt256
) {
  prepare(signer: auth(BorrowValue) &Account) {
    JanusMockFT.unwrap(
      signer: signer,
      accountAddress: accountAddress,
      claimedAmount: claimedAmount,
      recipient: recipient,
      txCommit: JanusMockFT.Commitment(x: txCommitX, y: txCommitY),
      amountProof: amountProof,
      amountPublicInputs: amountPublicInputs,
      transferPublicInputs: transferPublicInputs,
      transferProof: transferProof,
      encryptedSnapshot: encryptedSnapshot,
      ephPubX: ephPubX,
      ephPubY: ephPubY
    )
  }
}
`;
}

function buildPublishMemoKeyTx(contractAddr: string): string {
  return `
import JanusMockFT from ${contractAddr}

transaction(pubkeyX: UInt256, pubkeyY: UInt256) {
  prepare(signer: auth(BorrowValue) &Account) {
    JanusMockFT.publishMemoKey(signer: signer, pubkeyX: pubkeyX, pubkeyY: pubkeyY)
  }
}
`;
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
  let cap = acct.capabilities.borrow<&{FungibleToken.Balance}>(/public/${this.entry.ftContractName}Balance)
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

  async getMemoKey(addr: string): Promise<{ x: bigint; y: bigint } | null> {
    const fcl = await this._fcl();
    const script = `
import ${this.entry.contractName} from ${this.entry.cadenceAddress}

access(all) fun main(addr: Address): {String: UInt256} {
  return ${this.entry.contractName}.getMemoKeyPub(account: addr)
}
`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await fcl.query({
        cadence: script,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: (arg: any, types: any) => [arg(addr, types.Address)],
      });
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

    const cadence = buildWrapTx(this.entry.cadenceAddress);
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
        arg([] as string[], types.Array(types.UInt256)), // publicInputs
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
    const cadence = buildUnwrapTx(this.entry.cadenceAddress);
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
        arg([] as string[], types.Array(types.UInt256)), // amountPublicInputs
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

  // Cadence FT doesn't emit EVM events — scan returns empty for now.
  // A full Cadence event scanner is a v0.7 deliverable.
  async scanDeposits(_addr: string, _fromBlock?: bigint): Promise<DepositRecord[]> {
    return [];
  }

  async decryptNoteTo(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<NoteContent> {
    return decryptNote(blob, ephPub, myMemoPrivKey);
  }

  async decryptSnapshot(blob: Uint8Array, ephPub: Point, myMemoPrivKey: bigint): Promise<SnapshotContent> {
    const result = await decryptSnapshot(blob, ephPub, myMemoPrivKey);
    if (result === null) throw new Error("JanusFTAdapter.decryptSnapshot: decryption failed");
    return result;
  }

  async latestSnapshot(_addr: string, _myMemoPrivKey: bigint): Promise<SnapshotContent> {
    throw new Error(
      "JanusFTAdapter.latestSnapshot: Cadence event scanning not yet implemented (v0.7). " +
      "Track your balance locally from wrap/shieldedTransfer/unwrap return values."
    );
  }
}
