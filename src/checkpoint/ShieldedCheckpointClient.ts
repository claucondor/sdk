/**
 * checkpoint/ShieldedCheckpointClient.ts — EVM client for ShieldedCheckpoint.sol (v0.8.2).
 *
 * v0.8.2 BREAKING CHANGE: multi-token support.
 * Every method now takes an `address token` argument (the EVM proxy address of the Janus
 * token whose balance is being checkpointed). The contract stores one slot per
 * (owner, token) pair, so FLOW and mUSDC checkpoints are fully isolated.
 *
 * Protocol workflow (sender side):
 *   1. After shieldedTransfer on token T, the adapter returns a `checkpointPayload`.
 *   2. Pass `token` + `checkpointPayload` to ShieldedCheckpointClient.update() to write.
 *   3. On any new device / session recovery, call read(token, signer) + decryptSnapshot()
 *      to restore balance for that token.
 *
 * Privacy design:
 *   - Only the checkpoint owner (msg.sender) can call read() or update() for their slots.
 *   - Public metadata (version, lastConsumedNoteIndex, lastUpdatedBlock) readable by anyone.
 *   - The encrypted snapshot is opaque bytes — content schema defined by the SDK.
 *   - Cursor (lastConsumedNoteIndex) tracks inbox notes consumed into this checkpoint.
 *
 * Contract deployed at SHIELDED_CHECKPOINT_ADDRESS (immutable).
 * v0.8.2 address: 0x88C9fD443BC15d1Cd24bc724DB6928D3246b2E26
 */

import { ethers } from "ethers";
import { SHIELDED_CHECKPOINT_ADDRESS, FLOW_EVM_RPC } from "../network/contracts";
import { decryptSnapshot } from "../crypto/checkpoint-schema";
import type { SnapshotContent, CheckpointPayload } from "../types";

// ---------------------------------------------------------------------------
// ABI — v0.8.2 multi-token
// ---------------------------------------------------------------------------

const SHIELDED_CHECKPOINT_ABI = [
  // ── view (public) ──────────────────────────────────────────────────────
  "function exists(address user, address token) external view returns (bool)",
  "function metadata(address user, address token) external view returns (uint64 lastConsumedNoteIndex, uint64 lastUpdatedBlock, uint64 version, bool hasCheckpoint)",
  // ── view (owner-only via staticCall from signer) ───────────────────────
  "function read(address token) external view returns (tuple(bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, uint64 lastConsumedNoteIndex, uint64 lastUpdatedBlock, uint64 version) memory cp)",
  // ── write ──────────────────────────────────────────────────────────────
  "function update(address token, bytes calldata encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, uint64 lastConsumedNoteIndex) external",
  // ── events ─────────────────────────────────────────────────────────────
  "event CheckpointUpdated(address indexed owner, address indexed token, uint64 version, uint64 lastConsumedNoteIndex, uint64 blockNumber)",
  // ── errors ─────────────────────────────────────────────────────────────
  "error NoCheckpoint(address user, address token)",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckpointMetadata {
  lastConsumedNoteIndex: bigint;
  lastUpdatedBlock: bigint;
  version: bigint;
  hasCheckpoint: boolean;
}

export interface RawCheckpoint {
  encryptedSnapshot: Uint8Array;
  ephPubkeyX: bigint;
  ephPubkeyY: bigint;
  lastConsumedNoteIndex: bigint;
  lastUpdatedBlock: bigint;
  version: bigint;
}

export interface UpdateResult {
  txHash: string;
  version: bigint;
}

// ---------------------------------------------------------------------------
// ShieldedCheckpointClient
// ---------------------------------------------------------------------------

export class ShieldedCheckpointClient {
  readonly address: string;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly _contract: ethers.Contract;

  constructor(address = SHIELDED_CHECKPOINT_ADDRESS, rpcUrl = FLOW_EVM_RPC) {
    this.address = address;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this._contract = new ethers.Contract(address, SHIELDED_CHECKPOINT_ABI, this.provider);
  }

  // ── View (public) ─────────────────────────────────────────────────────

  /**
   * True if `user` has at least one checkpoint on-chain for `token`.
   *
   * @param user   EVM address of the checkpoint owner.
   * @param token  EVM proxy address of the Janus token (e.g. JanusFlow proxy).
   */
  async exists(user: string, token: string): Promise<boolean> {
    return this._contract.exists(user, token) as Promise<boolean>;
  }

  /**
   * Read non-sensitive public metadata for any user + token pair.
   * Safe to call without a signer; does NOT return the encrypted snapshot.
   *
   * @param user   EVM address of the checkpoint owner.
   * @param token  EVM proxy address of the Janus token.
   */
  async metadata(user: string, token: string): Promise<CheckpointMetadata> {
    const [lastConsumedNoteIndex, lastUpdatedBlock, version, hasCheckpoint] =
      await this._contract.metadata(user, token);
    return {
      lastConsumedNoteIndex: BigInt(lastConsumedNoteIndex),
      lastUpdatedBlock: BigInt(lastUpdatedBlock),
      version: BigInt(version),
      hasCheckpoint: Boolean(hasCheckpoint),
    };
  }

  // ── View (owner-only) ─────────────────────────────────────────────────

  /**
   * Read the caller's own full checkpoint (includes encrypted snapshot) for a token.
   *
   * Uses staticCall with the signer as `from` to satisfy the `msg.sender` ownership check.
   * Returns null if the caller has no checkpoint for this token (NoCheckpoint revert caught).
   *
   * @param token   EVM proxy address of the Janus token.
   * @param signer  Ethers wallet (checkpoint owner).
   */
  async read(token: string, signer: ethers.Wallet): Promise<RawCheckpoint | null> {
    const connected = this._contract.connect(signer) as ethers.Contract;
    try {
      const cp = await connected.read.staticCall(token);
      return {
        encryptedSnapshot: ethers.getBytes(cp.encryptedSnapshot),
        ephPubkeyX: BigInt(cp.ephPubkeyX),
        ephPubkeyY: BigInt(cp.ephPubkeyY),
        lastConsumedNoteIndex: BigInt(cp.lastConsumedNoteIndex),
        lastUpdatedBlock: BigInt(cp.lastUpdatedBlock),
        version: BigInt(cp.version),
      };
    } catch (err: unknown) {
      if (_isNoCheckpointError(err)) return null;
      throw err;
    }
  }

  /**
   * Read and decrypt the caller's checkpoint for `token` to recover SnapshotContent.
   * Convenience wrapper: read(token, signer) + decryptSnapshot().
   *
   * @param token         EVM proxy address of the Janus token.
   * @param signer        Ethers wallet (checkpoint owner).
   * @param memoPrivKey   BabyJub memo private key for ECIES decryption.
   * @returns             Decrypted snapshot, or null if no checkpoint exists or decryption fails.
   */
  async readAndDecrypt(
    token: string,
    signer: ethers.Wallet,
    memoPrivKey: bigint,
  ): Promise<SnapshotContent | null> {
    const raw = await this.read(token, signer);
    if (!raw) return null;
    return decryptSnapshot(
      raw.encryptedSnapshot,
      { x: raw.ephPubkeyX, y: raw.ephPubkeyY },
      memoPrivKey,
    );
  }

  // ── Write ─────────────────────────────────────────────────────────────

  /**
   * Write or overwrite the caller's checkpoint on-chain for `token`.
   *
   * @param token                 EVM proxy address of the Janus token.
   * @param payload               CheckpointPayload from orchestrateShieldedTransfer or
   *                              orchestrateWrap / orchestrateUnwrap.
   * @param lastConsumedNoteIndex Cursor: number of ShieldedInbox notes consumed so far.
   *                              Pass 0n if you haven't drained the inbox yet.
   * @param signer                Ethers wallet (checkpoint owner).
   */
  async update(
    token: string,
    payload: CheckpointPayload,
    lastConsumedNoteIndex: bigint,
    signer: ethers.Wallet,
  ): Promise<UpdateResult> {
    const connected = this._contract.connect(signer) as ethers.Contract;
    const tx = await connected.update(
      token,
      payload.encryptedSnapshot,
      payload.ephPubkeyX,
      payload.ephPubkeyY,
      lastConsumedNoteIndex,
    ) as ethers.TransactionResponse;
    const receipt = await tx.wait();

    // Parse the CheckpointUpdated event to get the new version number
    let version = 0n;
    if (receipt?.logs) {
      const iface = new ethers.Interface(SHIELDED_CHECKPOINT_ABI);
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "CheckpointUpdated") {
            version = BigInt(parsed.args.version);
            break;
          }
        } catch {
          // Not this event, continue
        }
      }
    }

    return { txHash: tx.hash, version };
  }

  /**
   * Convenience: encrypt and update checkpoint in a single call.
   * Uses the checkpoint-schema wire format ({v:1, bal, bld}).
   *
   * @param token                 EVM proxy address of the Janus token.
   * @param snapshot              Current balance/blinding state to persist.
   * @param lastConsumedNoteIndex Inbox drain cursor.
   * @param senderMemoKeypair     Caller's BabyJub keypair (pubkey used for encryption).
   * @param signer                Ethers wallet (checkpoint owner).
   */
  async encryptAndUpdate(
    token: string,
    snapshot: SnapshotContent,
    lastConsumedNoteIndex: bigint,
    senderMemoKeypair: { pubkey: { x: bigint; y: bigint }; privkey: bigint },
    signer: ethers.Wallet,
  ): Promise<UpdateResult> {
    const { encryptSnapshot } = await import("../crypto/checkpoint-schema");
    const enc = await encryptSnapshot(snapshot, senderMemoKeypair.pubkey);
    return this.update(
      token,
      {
        encryptedSnapshot: enc.ciphertext,
        ephPubkeyX: enc.ephemeralPubkey.x,
        ephPubkeyY: enc.ephemeralPubkey.y,
      },
      lastConsumedNoteIndex,
      signer,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check if an EVM revert is the `NoCheckpoint(address user, address token)` custom error.
 * The contract reverts with this error when read() is called for a user+token with no checkpoint.
 * We surface this as null (consistent with "not found" semantics).
 */
function _isNoCheckpointError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  // ethers v6 surfaces custom errors as "NoCheckpoint" in the decoded error name
  if (msg.includes("NoCheckpoint")) return true;
  // Also catch encoded 4-byte selector fallback (0x + first 4 bytes of keccak256("NoCheckpoint(address,address)"))
  // keccak256("NoCheckpoint(address,address)") = 0x9e87fac8...  — included for robustness
  if (msg.includes("0x9e87fac8")) return true;
  return false;
}
