/**
 * tokens/janus-token.ts — JanusToken EVM SDK class (ElGamal edition, UUPS-upgradeable)
 *
 * JanusToken replaces Pedersen commitments with additive ElGamal-on-BabyJubJub.
 * Each balance slot stores (c1, c2) = (r*G, m*G + r*PK) so multiple senders can
 * encrypt to the same recipient pubkey and the ciphertexts accumulate homomorphically.
 * The recipient decrypts to a sum total without learning per-sender amounts.
 *
 * PRIVACY PROPERTY (confirmed Phase 3 multi-user e2e 24/24):
 *   Bob deposits 10 + 25 + 7 = 42 FLOW from three senders.
 *   Bob decrypts accumulated slot → 42.
 *   Bob cannot learn individual sender amounts from the on-chain state.
 *
 * Canonical testnet deployment (current — UUPS-upgradeable, SCALE-fixed):
 *   Proxy: 0x025efe7e89acdb8F315C804BE7245F348AA9c538  (JanusToken UUPS proxy — call this)
 *   Impl:  0x28686066D28Eb86269190Eae76eD7170c21BB7FB  (current implementation)
 *   Owner: 0x0000000000000000000000022f6b30af48a94787 (openjanus-flow COA)
 *   BabyJub.sol: 0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
 *   EncryptConsistencyVerifier: 0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e
 *   DecryptOpenVerifier:        0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc
 *
 * What changed since the previous release:
 *   - Vulnerability 014 fixed: unwrap now multiplies claimed ZK units by SCALE = 1e18
 *     so users actually recover their FLOW (previously released 1 wei per FLOW wrapped).
 *   - ERC1967 proxy in front: future bugfixes ship as impl-only redeploys.
 *
 * DEPRECATED — DO NOT USE:
 *   0xb12E600fFcde967210cFD81CF9f32bBB6e68a499 — pre-SCALE-fix, locked FLOW stuck
 *   0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D — pre-ceremony, single-contributor zkeys
 *
 * Quick start (read-only):
 *   import { JanusToken, JANUS_TOKEN_TESTNET } from "@openjanus/sdk/tokens";
 *
 *   const token = new JanusToken(JANUS_TOKEN_TESTNET);
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
  TokenOptions,
  Ciphertext,
  EncryptedSlot,
} from "./types";
// Use the canonical proof result types from crypto/elgamal-proofs (uppercase C1/C2).
// The duplicate local definitions in tokens/types.ts are stale and predate the
// crypto consolidation; they are kept for backward compat in barrel exports but
// new code should reach for the crypto module's types.
import type {
  EncryptProofResult,
  DecryptProofResult,
} from "../crypto/elgamal-proofs";
import { NETWORK_CONFIG } from "../network/flow-client";

// ---------------------------------------------------------------------------
// Canonical deployment addresses
// ---------------------------------------------------------------------------

/** BabyJub.sol address (lab/stateless deployment, re-used from primitives — unchanged) */
export const JANUS_BABYJUB_ADDRESS = "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870";

/**
 * EncryptConsistencyVerifier — proves ciphertext encrypts m to PK.
 * v0.2.0: ceremony-backed (Hermez phase 1 + Flow VRF beacon block 323555648).
 */
export const ENCRYPT_CONSISTENCY_VERIFIER = "0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e";

/**
 * DecryptOpenVerifier — proves knowledge of sk for correct decryption.
 * v0.2.0: ceremony-backed (Hermez phase 1 + Flow VRF beacon block 323555648).
 */
export const DECRYPT_OPEN_VERIFIER = "0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc";

/**
 * Canonical testnet deployment options (current — UUPS proxy, ceremony-backed verifiers).
 * SCALE-fix e2e validated end-to-end (2026-05-26).
 */
export const JANUS_TOKEN_TESTNET: TokenOptions = {
  evmAddress: "0x025efe7e89acdb8F315C804BE7245F348AA9c538",
  network: "testnet",
  babyJubAddress: JANUS_BABYJUB_ADDRESS,
  encryptVerifierAddress: ENCRYPT_CONSISTENCY_VERIFIER,
  decryptVerifierAddress: DECRYPT_OPEN_VERIFIER,
};

/**
 * Deprecated JanusToken addresses retained for cross-referencing event history.
 * Importing apps must NOT use these for new wrap/transfer/unwrap calls.
 * @deprecated
 */
export const JANUS_TOKEN_DEPRECATED_ADDRESSES = {
  preScaleFix: "0xb12E600fFcde967210cFD81CF9f32bBB6e68a499",
  preCeremony: "0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D",
} as const;

// ---------------------------------------------------------------------------
// Minimal ABI — only methods the SDK calls
// ---------------------------------------------------------------------------

/**
 * ABI for the current UUPS-upgradeable JanusToken proxy.
 *
 * Method names match the on-chain Solidity contract:
 *   - wrap(address, Ciphertext, nonce, uint[6], uint[8]) payable
 *   - confidentialTransfer(address, Ciphertext, transferUnits, nonce, uint[6], uint[8])
 *   - unwrap(claimedUnits, address, uint[7], uint[8])
 *   - slotOf(address) view returns (Ciphertext)
 *
 * Argument semantics (CRITICAL — vuln 014 fix context):
 *   - wrap.msg.value MUST be a whole multiple of SCALE = 1e18 (one whole FLOW).
 *     The ciphertext encodes msg.value / SCALE, matching the circuit's small-int range.
 *   - confidentialTransfer.transferUnits is in WHOLE FLOW (not wei).
 *     SDK callers should pass `flowUnits` (a small bigint), not `wei`.
 *   - unwrap.claimedUnits is in WHOLE FLOW (matches the circuit's claimed_value).
 *     The contract converts internally to wei via `amountAtto = claimedUnits * SCALE`.
 *
 * Use `flowToWei` / `weiToFlow` helpers from `src/crypto/elgamal-proofs.ts` (or the
 * SDK index) to convert between whole-FLOW units and wei in app code.
 */
export const JANUS_TOKEN_ABI = [
  // Constants
  "function SCALE() view returns (uint256)",
  "function owner() view returns (address)",
  // Pubkey registration / rotation
  "function registerPubkey(uint256 x, uint256 y) external",
  "function pubkeyOf(address user) view returns (uint256 x, uint256 y)",
  "function hasPubkey(address) view returns (bool)",
  "function commitPubkeyRotation(uint256 newX, uint256 newY) external",
  "function finalizePubkeyRotation() external",
  "function pendingRotationOf(address user) view returns (uint256 newX, uint256 newY, uint256 availableAt)",
  // Slot reads
  "function slotOf(address user) view returns (tuple(uint256 C1x, uint256 C1y, uint256 C2x, uint256 C2y))",
  // Custody + replay
  "function nonce(address) view returns (uint256)",
  "function locked(address) view returns (uint256)",
  // Wrap (msg.value = N * SCALE; ciphertext encodes N whole-FLOW units)
  "function wrap(address to, tuple(uint256 C1x, uint256 C1y, uint256 C2x, uint256 C2y) ct, uint256 senderNonce, uint[6] publicInputs, uint[8] encryptProof) external payable",
  // Confidential transfer (transferUnits in whole FLOW)
  "function confidentialTransfer(address to, tuple(uint256 C1x, uint256 C1y, uint256 C2x, uint256 C2y) ct, uint256 transferUnits, uint256 senderNonce, uint[6] publicInputs, uint[8] encryptProof) external",
  // Unwrap (claimedUnits = whole-FLOW total from circuit; contract sends claimedUnits * SCALE)
  "function unwrap(uint256 claimedUnits, address recipient, uint[7] publicInputs, uint[8] decryptProof) external",
  // Events
  "event PubkeyRegistered(address indexed account, uint256 x, uint256 y)",
  "event PubkeyRotationCommitted(address indexed account, uint256 newX, uint256 newY, uint256 availableAt)",
  "event PubkeyRotationFinalized(address indexed account, uint256 newX, uint256 newY)",
  "event Wrapped(address indexed from, address indexed to, uint256 amountAttoFlow)",
  "event ConfidentialTransfer(address indexed from, address indexed to)",
  "event Unwrapped(address indexed account, address indexed recipient, uint256 amountAttoFlow)",
] as const;

// ---------------------------------------------------------------------------
// JanusToken class
// ---------------------------------------------------------------------------

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
    const slot = await this._contract().slotOf(account);
    const pk = await this.pubkeyOf(account);
    return {
      ciphertext: {
        c1: { x: BigInt(slot.C1x.toString()), y: BigInt(slot.C1y.toString()) },
        c2: { x: BigInt(slot.C2x.toString()), y: BigInt(slot.C2y.toString()) },
      },
      pubkey: pk,
    };
  }

  /**
   * Get only the raw ciphertext (no pubkey fetch).
   */
  async getBalanceCiphertext(account: string): Promise<Ciphertext> {
    const slot = await this._contract().slotOf(account);
    return {
      c1: { x: BigInt(slot.C1x.toString()), y: BigInt(slot.C1y.toString()) },
      c2: { x: BigInt(slot.C2x.toString()), y: BigInt(slot.C2y.toString()) },
    };
  }

  /** Read the current per-sender nonce (replay protection). */
  async nonceOf(account: string): Promise<bigint> {
    const n = await this._contract().nonce(account);
    return BigInt(n.toString());
  }

  /** Read the per-user locked attoFLOW custody balance held by the contract. */
  async lockedOf(account: string): Promise<bigint> {
    const v = await this._contract().locked(account);
    return BigInt(v.toString());
  }

  /** Read the SCALE constant (vuln 014 fix sanity check). Always 1e18 on the new proxy. */
  async getScale(): Promise<bigint> {
    const v = await this._contract().SCALE();
    return BigInt(v.toString());
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
  // Write: wrap (lock FLOW + encrypt-to-recipient)
  // ---------------------------------------------------------------------------

  /**
   * Wrap FLOW into a recipient's confidential slot.
   *
   * UNIT CONTRACT (vuln 014 lesson):
   *   - `flowUnits` is in WHOLE FLOW (e.g. 2n = 2 FLOW).
   *   - Internally we set msg.value = flowUnits * SCALE (1e18).
   *   - The ciphertext encodes `flowUnits` directly (small int the circuit handles).
   *
   * Pass plain bigints in whole FLOW. Wei conversion happens here.
   *
   * @param to          Recipient EVM address (must have registered pubkey)
   * @param flowUnits   Whole-FLOW units to wrap (must match the proof's encrypted value)
   * @param senderNonce Current per-sender nonce (read via nonceOf())
   * @param proofResult Result from buildEncryptProof()
   */
  async wrap(
    to: string,
    flowUnits: bigint,
    senderNonce: bigint,
    proofResult: EncryptProofResult
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const { ciphertext, proof, publicInputs } = proofResult;
    const SCALE = 10n ** 18n;
    const value = flowUnits * SCALE;
    const tx = await this._contract().wrap(
      to,
      {
        C1x: ciphertext.C1.x,
        C1y: ciphertext.C1.y,
        C2x: ciphertext.C2.x,
        C2y: ciphertext.C2.y,
      },
      senderNonce,
      publicInputs,
      proof,
      { value }
    );
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // Write: confidentialTransfer
  // ---------------------------------------------------------------------------

  /**
   * Confidential transfer of locked-FLOW custody from sender to recipient.
   *
   * UNIT CONTRACT: `transferUnits` is in WHOLE FLOW (not wei). The contract
   * multiplies by SCALE = 1e18 internally for the locked[] accounting.
   *
   * @param to            Recipient EVM address
   * @param transferUnits Whole-FLOW units to transfer
   * @param senderNonce   Current per-sender nonce
   * @param proofResult   Result from buildEncryptProof()
   */
  async confidentialTransfer(
    to: string,
    transferUnits: bigint,
    senderNonce: bigint,
    proofResult: EncryptProofResult
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const { ciphertext, proof, publicInputs } = proofResult;
    const tx = await this._contract().confidentialTransfer(
      to,
      {
        C1x: ciphertext.C1.x,
        C1y: ciphertext.C1.y,
        C2x: ciphertext.C2.x,
        C2y: ciphertext.C2.y,
      },
      transferUnits,
      senderNonce,
      publicInputs,
      proof
    );
    return tx.wait();
  }

  // ---------------------------------------------------------------------------
  // Write: unwrap (release locked FLOW with decrypt proof)
  // ---------------------------------------------------------------------------

  /**
   * Prove decryption of the accumulated slot and release FLOW to a recipient.
   *
   * UNIT CONTRACT (vuln 014 fix): `claimedUnits` is in WHOLE FLOW (small int from
   * the decrypt_open circuit). The contract converts via amountAtto = claimedUnits
   * * SCALE before sending and decrementing locked[].
   *
   * publicInputs[6] (claimed_value) MUST equal claimedUnits — the contract enforces.
   *
   * @param recipient    EVM address to receive the unwrapped FLOW
   * @param claimedUnits Whole-FLOW units being claimed
   * @param proofResult  Result from buildDecryptProof()
   */
  async unwrap(
    recipient: string,
    claimedUnits: bigint,
    proofResult: DecryptProofResult
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const { proof, publicInputs } = proofResult;
    const tx = await this._contract().unwrap(
      claimedUnits,
      recipient,
      publicInputs,
      proof
    );
    return tx.wait();
  }

  /**
   * @deprecated Use `unwrap(recipient, claimedUnits, proofResult)` — the old name
   *             tracked the pre-SCALE-fix API. Maintained for one release; remove
   *             in 0.3.x.
   */
  async decryptAndUnwrap(
    to: string,
    amount: bigint,
    proofResult: DecryptProofResult
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    return this.unwrap(to, amount, proofResult);
  }

  /**
   * @deprecated Use `wrap(to, flowUnits, senderNonce, proofResult)` — semantics
   *             changed in 0.2.1 to take whole-FLOW units instead of wei.
   *             Maintained for one release; remove in 0.3.x.
   */
  async encryptTo(
    recipient: string,
    proofResult: EncryptProofResult,
    valueWei: bigint
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const SCALE = 10n ** 18n;
    if (valueWei % SCALE !== 0n) {
      throw new Error(
        `JanusToken.encryptTo (deprecated): valueWei must be a whole multiple of ${SCALE} (one FLOW). Migrate to wrap(to, flowUnits, nonce, proofResult).`
      );
    }
    const flowUnits = valueWei / SCALE;
    const nonceVal = await this.nonceOf(await this.signer?.getAddress?.() ?? recipient);
    return this.wrap(recipient, flowUnits, nonceVal, proofResult);
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
