/**
 * inbox/CadenceInboxClient.ts — Cadence ShieldedInbox reader for JanusFT notes.
 *
 * JanusFT.shieldedTransfer deposits notes directly to the recipient's Cadence
 * ShieldedInbox (resource at /storage/shieldedInbox, capability at /public/shieldedInbox).
 * This inbox is DISTINCT from the EVM ShieldedInbox used by JanusFlow + JanusERC20.
 *
 * Key structural differences from EVM inbox:
 *   - The `sender` field is the Cadence address of the sender (not a token contract address).
 *   - Block reference is `blockHeight` (UInt64), not EVM block number.
 *   - The inbox head pointer advances on drainAll/drainBatch; peek() returns only PENDING notes.
 *   - No external cursor is needed — the inbox itself tracks what has been consumed.
 *
 * Usage:
 *   const notes = await getCadenceInboxNotes("0x7599043aea001283", {
 *     flowAccessNode: "https://rest-testnet.onflow.org",
 *     inboxContractAddress: "0x4b6bc58bc8bf5dcc",
 *   });
 */

import { FLOW_CADENCE_ACCESS, CADENCE_DEPLOYER_ADDRESS } from "../network/contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CadenceInboxNote {
  /** ECIES-encrypted note ciphertext */
  ciphertext: Uint8Array;
  /** Ephemeral pubkey X component (for ECIES decryption) */
  ephPubkeyX: bigint;
  /** Ephemeral pubkey Y component (for ECIES decryption) */
  ephPubkeyY: bigint;
  /**
   * Cadence address of the sender.
   * This is fromAccount in JanusFT.shieldedTransfer — the depositor field in
   * ShieldedInbox.Note. NOT the JanusFT contract address.
   */
  sender: string;
  /**
   * Position in the peek result (0-based).
   * Equals the absolute note position from the current head pointer.
   * All returned notes are PENDING (not yet drained) — no external cursor needed.
   */
  index: number;
  /** Block height when the note was deposited (Cadence UInt64) */
  blockHeight: bigint;
}

// ---------------------------------------------------------------------------
// Internal: Cadence script builder
// ---------------------------------------------------------------------------

/**
 * Build a Cadence script that returns all pending notes for a user's inbox.
 * Returns [] if the user has no inbox installed (non-panicking).
 */
function buildPeekAllScript(inboxContractAddress: string): string {
  return `
import ShieldedInbox from ${inboxContractAddress}

access(all) fun main(addr: Address): [ShieldedInbox.Note] {
    let inbox = getAccount(addr)
        .capabilities.borrow<&{ShieldedInbox.Receiver}>(/public/shieldedInbox)
    if inbox == nil {
        return []
    }
    let n = inbox!.count()
    if n == 0 {
        return []
    }
    return inbox!.peek(offset: 0, limit: n)
}
`;
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Read all PENDING notes from a Cadence ShieldedInbox.
 *
 * This is a non-consuming peek — no on-chain state is modified.
 * The Cadence inbox head pointer tracks what has been drained; this function
 * returns only notes at indices >= head (i.e., not yet claimed).
 *
 * Returns [] if the account has no ShieldedInbox installed.
 *
 * @param cadenceAddr   Cadence account address (e.g. "0x7599043aea001283")
 * @param opts          Options — access node and contract address
 */
export async function getCadenceInboxNotes(
  cadenceAddr: string,
  opts: {
    flowAccessNode?: string;
    inboxContractAddress?: string;
  } = {},
): Promise<CadenceInboxNote[]> {
  const accessNode = opts.flowAccessNode ?? FLOW_CADENCE_ACCESS;
  const contractAddr = opts.inboxContractAddress ?? CADENCE_DEPLOYER_ADDRESS;

  // Dynamic import — avoids SSR issues and keeps FCL out of the main bundle
  const fcl = await import("@onflow/fcl");
  fcl.config({ "accessNode.api": accessNode });

  const script = buildPeekAllScript(contractAddr);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  try {
    result = await fcl.query({
      cadence: script,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any, types: any) => [arg(cadenceAddr, types.Address)],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // "execution error" from Flow usually means the account has no inbox installed
    // (the script returns [] for nil inbox, but panics on other errors)
    if (
      msg.includes("has no ShieldedInbox") ||
      msg.includes("has not installed") ||
      msg.includes("capabilities.borrow")
    ) {
      return [];
    }
    throw err;
  }

  if (!Array.isArray(result) || result.length === 0) {
    return [];
  }

  // FCL decodes Cadence struct fields as JS object properties:
  //   [UInt8]  → string[] or number[] (each element is a uint8 value)
  //   UInt256  → string (decimal)
  //   Address  → string (hex, e.g. "0x7599043aea001283")
  //   UInt64   → string (decimal)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any[]).map((note, idx) => {
    // Handle both string[] and number[] for [UInt8]
    const rawCiphertext: Array<string | number> = Array.isArray(note.ciphertext)
      ? note.ciphertext
      : [];
    return {
      ciphertext: new Uint8Array(rawCiphertext.map((v) => Number(v))),
      ephPubkeyX: BigInt(note.ephPubkeyX),
      ephPubkeyY: BigInt(note.ephPubkeyY),
      sender: note.depositor as string,
      index: idx,
      blockHeight: BigInt(note.blockHeight),
    };
  });
}
