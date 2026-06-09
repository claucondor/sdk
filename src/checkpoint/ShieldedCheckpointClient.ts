/**
 * checkpoint/ShieldedCheckpointClient.ts — EVM client for ShieldedCheckpoint.sol (v0.8).
 *
 * ShieldedCheckpoint is the sender-side encrypted state store for Janus.
 * It replaces event-scanning as the canonical source of truth for a user's own balance.
 *
 * Protocol workflow (sender side):
 *   1. After shieldedTransfer, the adapter returns a `checkpointPayload`:
 *        { encryptedSnapshot, ephPubkeyX, ephPubkeyY }
 *   2. Pass `checkpointPayload` to ShieldedCheckpointClient.update() to write it on-chain.
 *   3. On any new device / session recovery, call read() + decryptSnapshot() to restore balance.
 *
 * Privacy design:
 *   - Only the checkpoint owner (msg.sender) can call read() or update().
 *   - Public metadata (version, lastConsumedNoteIndex, lastUpdatedBlock) is readable by anyone.
 *   - The encrypted snapshot is opaque bytes — content schema is defined by the SDK
 *     (see src/crypto/checkpoint-schema.ts: {v:1, bal, bld}).
 *   - Cursor (lastConsumedNoteIndex) tracks how many ShieldedInbox notes the user has
 *     consumed into this checkpoint — enables partial-drain resumption.
 *
 * The contract is deployed at SHIELDED_CHECKPOINT_ADDRESS (immutable, no upgrades).
 */

import { ethers } from "ethers";
import { SHIELDED_CHECKPOINT_ADDRESS, FLOW_EVM_RPC } from "../network/contracts";
import { decryptSnapshot } from "../crypto/checkpoint-schema";
import type { SnapshotContent, CheckpointPayload } from "../types";

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

const SHIELDED_CHECKPOINT_ABI = [
  // ── view (public) ──────────────────────────────────────────────────────
  "function exists(address user) external view returns (bool)",
  "function metadata(address user) external view returns (uint64 lastConsumedNoteIndex, uint64 lastUpdatedBlock, uint64 version, bool hasCheckpoint)",
  // ── view (owner-only via staticCall from signer) ───────────────────────
  "function read() external view returns (tuple(bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, uint64 lastConsumedNoteIndex, uint64 lastUpdatedBlock, uint64 version) memory cp)",
  // ── write ──────────────────────────────────────────────────────────────
  "function update(bytes calldata encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, uint64 lastConsumedNoteIndex) external",
  // ── events ─────────────────────────────────────────────────────────────
  "event CheckpointUpdated(address indexed owner, uint64 version, uint64 lastConsumedNoteIndex, uint64 blockNumber)",
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
   * True if `user` has at least one checkpoint on-chain.
   */
  async exists(user: string): Promise<boolean> {
    return this._contract.exists(user) as Promise<boolean>;
  }

  /**
   * Read non-sensitive public metadata for any user.
   * Safe to call without a signer; does NOT return the encrypted snapshot.
   */
  async metadata(user: string): Promise<CheckpointMetadata> {
    const [lastConsumedNoteIndex, lastUpdatedBlock, version, hasCheckpoint] =
      await this._contract.metadata(user);
    return {
      lastConsumedNoteIndex: BigInt(lastConsumedNoteIndex),
      lastUpdatedBlock: BigInt(lastUpdatedBlock),
      version: BigInt(version),
      hasCheckpoint: Boolean(hasCheckpoint),
    };
  }

  // ── View (owner-only) ─────────────────────────────────────────────────

  /**
   * Read the caller's own full checkpoint (includes encrypted snapshot).
   *
   * Uses staticCall with the signer as `from` to satisfy the `msg.sender` ownership check.
   * Throws if the caller has no checkpoint on-chain (call exists() first).
   *
   * @param signer  Ethers wallet (checkpoint owner).
   */
  async read(signer: ethers.Wallet): Promise<RawCheckpoint> {
    const connected = this._contract.connect(signer) as ethers.Contract;
    const cp = await connected.read.staticCall();
    return {
      encryptedSnapshot: ethers.getBytes(cp.encryptedSnapshot),
      ephPubkeyX: BigInt(cp.ephPubkeyX),
      ephPubkeyY: BigInt(cp.ephPubkeyY),
      lastConsumedNoteIndex: BigInt(cp.lastConsumedNoteIndex),
      lastUpdatedBlock: BigInt(cp.lastUpdatedBlock),
      version: BigInt(cp.version),
    };
  }

  /**
   * Read and decrypt the caller's checkpoint to recover SnapshotContent.
   * Convenience wrapper: read() + decryptSnapshot().
   *
   * @param signer        Ethers wallet (checkpoint owner).
   * @param memoPrivKey   BabyJub memo private key for ECIES decryption.
   * @returns             Decrypted snapshot, or null if no checkpoint exists or decryption fails.
   */
  async readAndDecrypt(
    signer: ethers.Wallet,
    memoPrivKey: bigint,
  ): Promise<SnapshotContent | null> {
    if (!(await this.exists(signer.address))) return null;
    const raw = await this.read(signer);
    return decryptSnapshot(
      raw.encryptedSnapshot,
      { x: raw.ephPubkeyX, y: raw.ephPubkeyY },
      memoPrivKey,
    );
  }

  // ── Write ─────────────────────────────────────────────────────────────

  /**
   * Write or overwrite the caller's checkpoint on-chain.
   *
   * @param payload               CheckpointPayload from orchestrateShieldedTransfer or
   *                              orchestrateWrap / orchestrateUnwrap.
   * @param lastConsumedNoteIndex Cursor: number of ShieldedInbox notes consumed so far.
   *                              Pass 0n if you haven't drained the inbox yet.
   * @param signer                Ethers wallet (checkpoint owner).
   */
  async update(
    payload: CheckpointPayload,
    lastConsumedNoteIndex: bigint,
    signer: ethers.Wallet,
  ): Promise<UpdateResult> {
    const connected = this._contract.connect(signer) as ethers.Contract;
    const tx = await connected.update(
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
   * This is a lower-level helper — most callers should use the `checkpointPayload`
   * returned by shieldedTransfer() and pass it directly to update().
   *
   * @param snapshot              Current balance/blinding state to persist.
   * @param lastConsumedNoteIndex Inbox drain cursor.
   * @param senderMemoKeypair     Caller's BabyJub keypair (pubkey used for encryption).
   * @param signer                Ethers wallet (checkpoint owner).
   */
  async encryptAndUpdate(
    snapshot: SnapshotContent,
    lastConsumedNoteIndex: bigint,
    senderMemoKeypair: { pubkey: { x: bigint; y: bigint }; privkey: bigint },
    signer: ethers.Wallet,
  ): Promise<UpdateResult> {
    const { encryptSnapshot } = await import("../crypto/checkpoint-schema");
    const enc = await encryptSnapshot(snapshot, senderMemoKeypair.pubkey);
    return this.update(
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
