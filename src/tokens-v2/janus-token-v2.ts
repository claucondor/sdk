/**
 * tokens-v2/janus-token-v2.ts — JanusTokenV2 EVM SDK class (ElGamal edition)
 *
 * JanusTokenV2 replaces Pedersen commitments with additive ElGamal-on-BabyJubJub.
 * Each balance slot stores (c1, c2) = (r*G, m*G + r*PK) so multiple senders can
 * encrypt to the same recipient pubkey and the ciphertexts accumulate homomorphically.
 * The recipient decrypts to a sum total without learning per-sender amounts.
 *
 * PRIVACY PROPERTY (confirmed Phase 3 multi-user e2e 24/24):
 *   Bob deposits 10 + 25 + 7 = 42 FLOW from three senders.
 *   Bob decrypts accumulated slot → 42.
 *   Bob cannot learn individual sender amounts from the on-chain state.
 *
 * Canonical testnet deployment (v2):
 *   EVM:  0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D  (JanusTokenV2)
 *   BabyJub.sol: 0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
 *   EncryptConsistencyVerifier: 0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C
 *   DecryptOpenVerifier:        0x3bB139B5404fD6b152813bC3532367AAa096638b
 *
 * Quick start (read-only):
 *   import { JanusTokenV2, JANUS_TOKEN_V2_TESTNET } from "@openjanus/sdk/tokens-v2";
 *
 *   const token = new JanusTokenV2(JANUS_TOKEN_V2_TESTNET);
 *   await token.connect();
 *   const slot = await token.getBalanceSlot("0xAlice");
 *
 * Quick start (with signer):
 *   const wallet = await createEvmWallet(privateKey, "testnet");
 *   await token.connectWithSigner(wallet);
 *   await token.registerPubkey(aliceKeypair.pk);
 */

import type { Point } from "../types/commitment";
import type {
  TokenV2Options,
  Ciphertext,
  EncryptedSlot,
  EncryptProofResult,
  DecryptProofResult,
} from "./types";
import { NETWORK_CONFIG } from "../network/flow-client";

// ---------------------------------------------------------------------------
// Canonical deployment addresses
// ---------------------------------------------------------------------------

/** BabyJub.sol address used by v2 (lab/stateless deployment, re-used from primitives) */
export const JANUS_V2_BABYJUB_ADDRESS = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";

/** EncryptConsistencyVerifier — proves ciphertext encrypts m to PK */
export const ENCRYPT_CONSISTENCY_VERIFIER = "0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C";

/** DecryptOpenVerifier — proves knowledge of sk for correct decryption */
export const DECRYPT_OPEN_VERIFIER = "0x3bB139B5404fD6b152813bC3532367AAa096638b";

/** Canonical v2 testnet deployment options */
export const JANUS_TOKEN_V2_TESTNET: TokenV2Options = {
  evmAddress: "0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D",
  network: "testnet",
  babyJubAddress: JANUS_V2_BABYJUB_ADDRESS,
  encryptVerifierAddress: ENCRYPT_CONSISTENCY_VERIFIER,
  decryptVerifierAddress: DECRYPT_OPEN_VERIFIER,
};

// ---------------------------------------------------------------------------
// Minimal ABI — only methods the SDK calls
// ---------------------------------------------------------------------------

export const JANUS_TOKEN_V2_ABI = [
  // Pubkey registration
  "function registerPubkey(uint256 pkx, uint256 pky)",
  "function pubkeyOf(address account) view returns (uint256 pkx, uint256 pky)",
  "function hasPubkey(address account) view returns (bool)",
  // Slot reads
  "function getSlot(address account) view returns (tuple(uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y))",
  "function getSlotRaw(address account) view returns (uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y)",
  // Encrypt (wrap/transfer to recipient) — state-changing
  "function encryptTo(address recipient, uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, uint256[8] proof, uint256[6] pubInputs) payable",
  "function encryptToRaw(address recipient, uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, uint256[8] proof, uint256[6] pubInputs) payable",
  // Decrypt-and-unwrap — proves decryption correctness, releases FLOW
  "function decryptAndUnwrap(address to, uint256 amount, uint256[8] proof, uint256[5] pubInputs)",
  // Confidential transfer (encrypt to recipient, update sender slot)
  "function confidentialTransfer(address recipient, uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, uint256[8] encProof, uint256[6] encPubInputs)",
  // Events
  "event PubkeyRegistered(address indexed account, uint256 pkx, uint256 pky)",
  "event SlotUpdated(address indexed account, uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y)",
  "event Unwrapped(address indexed account, address indexed to, uint256 amount)",
] as const;

// ---------------------------------------------------------------------------
// JanusTokenV2 class
// ---------------------------------------------------------------------------

export class JanusTokenV2 {
  private readonly opts: TokenV2Options;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private contract: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private signer: any = null;

  constructor(opts: TokenV2Options) {
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
    this.contract = new ethers.Contract(this.opts.evmAddress, JANUS_TOKEN_V2_ABI, provider);
    return this;
  }

  /** Connect with a signing wallet. Enables state-changing functions. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async connectWithSigner(signer: any): Promise<this> {
    const { ethers } = await import("ethers");
    this.signer = signer;
    this.contract = new ethers.Contract(this.opts.evmAddress, JANUS_TOKEN_V2_ABI, signer);
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
  // View: pubkey
  // ---------------------------------------------------------------------------

  /**
   * Return the registered BabyJubJub public key for an account.
   * Returns identity (0,1) if not registered.
   */
  async pubkeyOf(account: string): Promise<Point> {
    const [pkx, pky] = await this._contract().pubkeyOf(account);
    return { x: BigInt(pkx.toString()), y: BigInt(pky.toString()) };
  }

  /** Return true if the account has registered a pubkey. */
  async hasPubkey(account: string): Promise<boolean> {
    return this._contract().hasPubkey(account);
  }

  // ---------------------------------------------------------------------------
  // View: slot
  // ---------------------------------------------------------------------------

  /**
   * Read an account's encrypted balance slot.
   * Returns an identity ciphertext (c1=(0,1), c2=(0,1)) if the slot is empty.
   */
  async getBalanceSlot(account: string): Promise<EncryptedSlot> {
    const [c1x, c1y, c2x, c2y] = await this._contract().getSlotRaw(account);
    const pk = await this.pubkeyOf(account);
    return {
      ciphertext: {
        c1: { x: BigInt(c1x.toString()), y: BigInt(c1y.toString()) },
        c2: { x: BigInt(c2x.toString()), y: BigInt(c2y.toString()) },
      },
      pubkey: pk,
    };
  }

  /**
   * Get only the raw ciphertext (no pubkey fetch).
   */
  async getBalanceCiphertext(account: string): Promise<Ciphertext> {
    const [c1x, c1y, c2x, c2y] = await this._contract().getSlotRaw(account);
    return {
      c1: { x: BigInt(c1x.toString()), y: BigInt(c1y.toString()) },
      c2: { x: BigInt(c2x.toString()), y: BigInt(c2y.toString()) },
    };
  }

  // ---------------------------------------------------------------------------
  // Write: registerPubkey
  // ---------------------------------------------------------------------------

  /**
   * Register a BabyJubJub public key for an account.
   * Must be called once before the account can receive encrypted balances.
   *
   * @param pk  BabyJubJub public key (on-curve point)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async registerPubkey(pk: Point): Promise<any> {
    const tx = await this._contract().registerPubkey(pk.x, pk.y);
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // Write: encryptTo (wrap FLOW + encrypt to recipient)
  // ---------------------------------------------------------------------------

  /**
   * Encrypt an amount to a recipient's pubkey and update their slot (with FLOW value).
   * Caller must send the FLOW amount as msg.value.
   *
   * @param recipient   Recipient EVM address (must have registered pubkey)
   * @param proofResult Result from buildEncryptProof()
   * @param value       FLOW amount in wei to lock (as bigint)
   */
  async encryptTo(
    recipient: string,
    proofResult: EncryptProofResult,
    value: bigint
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const { ciphertext, proof, publicInputs } = proofResult;
    const tx = await this._contract().encryptTo(
      recipient,
      ciphertext.c1.x,
      ciphertext.c1.y,
      ciphertext.c2.x,
      ciphertext.c2.y,
      proof,
      publicInputs,
      { value }
    );
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // Write: confidentialTransfer
  // ---------------------------------------------------------------------------

  /**
   * Confidential transfer: encrypt amount to recipient, update sender slot.
   * Both sender's slot decrease and recipient's slot increase happen atomically.
   *
   * @param recipient   Recipient EVM address
   * @param proofResult Result from buildEncryptProof()
   */
  async confidentialTransfer(
    recipient: string,
    proofResult: EncryptProofResult
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const { ciphertext, proof, publicInputs } = proofResult;
    const tx = await this._contract().confidentialTransfer(
      recipient,
      ciphertext.c1.x,
      ciphertext.c1.y,
      ciphertext.c2.x,
      ciphertext.c2.y,
      proof,
      publicInputs
    );
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // Write: decryptAndUnwrap
  // ---------------------------------------------------------------------------

  /**
   * Prove decryption is correct and release FLOW to a recipient address.
   *
   * @param to           EVM address to receive unwrapped FLOW
   * @param amount       Plaintext amount being claimed
   * @param proofResult  Result from buildDecryptProof()
   */
  async decryptAndUnwrap(
    to: string,
    amount: bigint,
    proofResult: DecryptProofResult
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const { proof, publicInputs } = proofResult;
    const tx = await this._contract().decryptAndUnwrap(to, amount, proof, publicInputs);
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _contract(): any {
    if (!this.contract) {
      throw new Error(
        "JanusTokenV2: not connected. Call await token.connect() or await token.connectWithSigner(signer) first."
      );
    }
    return this.contract;
  }
}
