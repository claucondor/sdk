/**
 * tokens/janus-token.ts — JanusToken EVM SDK class
 *
 * High-level interface for interacting with a deployed JanusToken contract.
 * Supports both NATIVE mode (own supply) and WRAPPER mode (wraps ERC-20).
 *
 * Canonical testnet deployment (NATIVE mode demo):
 *   EVM: 0x53F49881A1132FF4F674D2c015e35D5B07Fa1F4A
 *   Cadence: 0x28fef3d1d6a12800 (contract: JanusToken)
 *
 * Quick start (read-only):
 *   import { JanusToken, JANUS_TOKEN_TESTNET } from "@openjanus/sdk/tokens";
 *
 *   const token = new JanusToken(JANUS_TOKEN_TESTNET);
 *   await token.connect();
 *   const commit = await token.balanceOfCommitment("0xAlice");
 *
 * Quick start (with signer):
 *   const wallet = await createEvmWallet(privateKey, "testnet");
 *   await token.connectWithSigner(wallet);
 *   await token.mintXY("0xAlice", cx, cy);
 */

import type { CommitmentXY } from "../types/commitment";
import type { TokenOptions, TransferProofInput, TransferProofResult } from "./types";
import { NETWORK_CONFIG } from "../network/flow-client";
import { computeCommitment } from "../crypto/commitment";
import { buildTransferProof } from "../crypto/transfer-proof";

/** Minimal ABI for JanusToken — only the methods the SDK calls */
export const JANUS_TOKEN_ABI = [
  // View
  "function balanceOfCommitment(address) view returns (tuple(uint256 x, uint256 y))",
  "function balanceOfCommitmentXY(address) view returns (uint256 x, uint256 y)",
  "function totalSupplyCommitment() view returns (tuple(uint256 x, uint256 y))",
  "function isWrapperMode() view returns (bool)",
  "function underlying() view returns (address)",
  "function owner() view returns (address)",
  "function verifier() view returns (address)",
  "function babyJub() view returns (address)",
  // State-changing (NATIVE mode)
  "function mintXY(address to, uint256 cx, uint256 cy)",
  "function burnXY(address from, uint256 cx, uint256 cy)",
  // State-changing (WRAPPER mode)
  "function wrap(uint256 amount, tuple(uint256 x, uint256 y) amountCommitment)",
  "function unwrap(address from, uint256 amount, tuple(uint256 x, uint256 y) amountCommitment)",
  // State-changing (all modes)
  "function confidentialTransfer(address to, uint256[6] publicInputs, uint256[8] proof)",
  // Events
  "event ConfidentialMint(address indexed to, uint256 new_commit_x, uint256 new_commit_y)",
  "event ConfidentialTransfer(address indexed from, address indexed to)",
  "event ConfidentialBurn(address indexed from, uint256 new_commit_x, uint256 new_commit_y)",
  "event Wrap(address indexed account, uint256 amount, uint256 commit_x, uint256 commit_y)",
  "event Unwrap(address indexed account, uint256 amount, uint256 new_commit_x, uint256 new_commit_y)",
] as const;

/** Canonical testnet deployment options (NATIVE mode demo) */
export const JANUS_TOKEN_TESTNET: TokenOptions = {
  evmAddress: "0x53F49881A1132FF4F674D2c015e35D5B07Fa1F4A",
  network: "testnet",
};

export class JanusToken {
  private readonly opts: TokenOptions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private contract: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private signer: any = null;

  constructor(opts: TokenOptions) {
    this.opts = opts;
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  /** Connect with a read-only provider. Enables all view functions. */
  async connect(): Promise<this> {
    const { ethers } = await import("ethers");
    const rpc = NETWORK_CONFIG[this.opts.network].evmRpc;
    const provider = new ethers.JsonRpcProvider(rpc);
    this.contract = new ethers.Contract(this.opts.evmAddress, JANUS_TOKEN_ABI, provider);
    return this;
  }

  /** Connect with a signing wallet. Enables state-changing functions. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async connectWithSigner(signer: any): Promise<this> {
    const { ethers } = await import("ethers");
    this.signer = signer;
    this.contract = new ethers.Contract(this.opts.evmAddress, JANUS_TOKEN_ABI, signer);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  /** Return the deployed EVM address. */
  get address(): string {
    return this.opts.evmAddress;
  }

  // ---------------------------------------------------------------------------
  // View functions
  // ---------------------------------------------------------------------------

  /** Return the balance commitment for an address. Identity (0,1) = zero balance. */
  async balanceOfCommitment(account: string): Promise<CommitmentXY> {
    const [x, y] = await this._contract().balanceOfCommitmentXY(account);
    return { x: BigInt(x.toString()), y: BigInt(y.toString()) };
  }

  /** Return the total supply commitment. */
  async totalSupplyCommitment(): Promise<CommitmentXY> {
    const result = await this._contract().totalSupplyCommitment();
    return { x: BigInt(result.x.toString()), y: BigInt(result.y.toString()) };
  }

  /** Return true if this instance is in WRAPPER mode. */
  async isWrapperMode(): Promise<boolean> {
    return this._contract().isWrapperMode();
  }

  // ---------------------------------------------------------------------------
  // NATIVE mode: mint / burn
  // ---------------------------------------------------------------------------

  /**
   * Mint a Pedersen commitment to an address (NATIVE mode, owner only).
   *
   * @param to  Recipient EVM address
   * @param cx  Commitment x-coordinate
   * @param cy  Commitment y-coordinate
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async mintXY(to: string, cx: bigint, cy: bigint): Promise<any> {
    const tx = await this._contract().mintXY(to, cx, cy);
    return tx.wait();
  }

  /**
   * Compute Pedersen commitment and mint it (NATIVE mode, owner only).
   * Returns the commitment point for the caller to store.
   *
   * @param to       Recipient EVM address
   * @param amount   Token amount (must be < 2^64)
   * @param blinding 128-bit blinding factor (store this!)
   */
  async mint(
    to: string,
    amount: bigint,
    blinding: bigint
  ): Promise<{ receipt: unknown; commit: CommitmentXY }> {
    const commit = await computeCommitment(amount, blinding);
    const receipt = await this.mintXY(to, commit.x, commit.y);
    return { receipt, commit };
  }

  /**
   * Burn a Pedersen commitment from an address (NATIVE mode, owner only).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async burnXY(from: string, cx: bigint, cy: bigint): Promise<any> {
    const tx = await this._contract().burnXY(from, cx, cy);
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // WRAPPER mode: wrap / unwrap
  // ---------------------------------------------------------------------------

  /**
   * Wrap underlying tokens into a confidential commitment (WRAPPER mode).
   * Caller must have approved this contract for `amount` of the underlying token.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async wrap(amount: bigint, commitment: CommitmentXY): Promise<any> {
    const tx = await this._contract().wrap(amount, {
      x: commitment.x,
      y: commitment.y,
    });
    return tx.wait();
  }

  /**
   * Unwrap: burn commitment and release underlying tokens (WRAPPER mode, owner only).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async unwrap(from: string, amount: bigint, commitment: CommitmentXY): Promise<any> {
    const tx = await this._contract().unwrap(from, amount, {
      x: commitment.x,
      y: commitment.y,
    });
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // Core: confidentialTransfer
  // ---------------------------------------------------------------------------

  /**
   * Execute a confidential transfer.
   * The proof must be pre-generated with buildTransferProof().
   *
   * @param to           Recipient EVM address
   * @param publicInputs [C_old.x, C_old.y, C_tx.x, C_tx.y, C_new.x, C_new.y]
   * @param proof        [pA.x, pA.y, pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC.x, pC.y]
   */
  async confidentialTransfer(
    to: string,
    publicInputs: [bigint, bigint, bigint, bigint, bigint, bigint],
    proof: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const tx = await this._contract().confidentialTransfer(to, publicInputs, proof);
    return tx.wait();
  }

  /**
   * Generate a proof and execute a confidential transfer in one call.
   */
  async proveAndTransfer(
    to: string,
    proofInput: TransferProofInput
  ): Promise<{ receipt: unknown; proofResult: TransferProofResult }> {
    const proofResult = await buildTransferProof(proofInput);
    const receipt = await this.confidentialTransfer(
      to,
      proofResult.publicInputs,
      proofResult.proof
    );
    return { receipt, proofResult };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _contract(): any {
    if (!this.contract) {
      throw new Error(
        "JanusToken: not connected. Call await token.connect() or await token.connectWithSigner(signer) first."
      );
    }
    return this.contract;
  }
}
