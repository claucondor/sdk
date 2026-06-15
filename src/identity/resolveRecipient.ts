/**
 * identity/resolveRecipient.ts — Cross-VM recipient resolution helper.
 *
 * Normalises a recipient address (either Cadence 8-byte or EVM 20-byte) into a
 * unified ResolvedRecipient that contains:
 *   - the canonical EVM COA address (always needed for MemoKeyRegistry lookup)
 *   - the Cadence address when resolvable (needed for MockFT shieldedTransfer)
 *   - the memo public key from MemoKeyRegistry (null if not yet activated)
 *
 * Design rules:
 *   - Cadence address: /^0x[a-fA-F0-9]{16}$/ (8 bytes)
 *   - EVM address:     /^0x[a-fA-F0-9]{40}$/ (20 bytes)
 *   - Mixed or invalid: throw with clear message
 *
 * MemoKeyRegistry ABI:
 *   getMemoKey(address user) → (uint256 x, uint256 y, uint256 publishedAt)
 *   Returns (0, 0, 0) when the address has never called publishMemoKey().
 */

import { ethers } from "ethers";
import { FLOW_CADENCE_ACCESS } from "../network/contracts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedRecipient {
  /** How the caller provided the address. */
  inputType: "cadence" | "evm";
  /** The original input, normalised (lowercase 0x-prefixed). */
  inputNormalized: string;
  /**
   * Cadence address when resolvable.
   * - Always present when inputType === "cadence".
   * - Absent (undefined) when inputType === "evm" and no reverse-resolution is attempted.
   */
  cadenceAddress?: string;
  /**
   * EVM COA address (checksummed 0x40-char hex).
   * Always populated — this is the MemoKeyRegistry lookup key.
   * For EVM input: the input itself.
   * For Cadence input: the /public/evm COA resolved on-chain.
   */
  evmCoaAddress: string;
  /**
   * BabyJub public key from MemoKeyRegistry, or null if address has not yet
   * called publishMemoKey() (getMemoKey returns (0, 0, *)).
   */
  memoKey: { pubkeyX: bigint; pubkeyY: bigint } | null;
  /** true when memoKey !== null AND (pubkeyX, pubkeyY) !== (0n, 0n). */
  isActivated: boolean;
}

export interface ResolveRecipientOpts {
  /** EVM JSON-RPC endpoint used to query MemoKeyRegistry. */
  rpc: string;
  /** MemoKeyRegistry contract address (EVM). */
  memoKeyRegistryAddr: string;
  /**
   * Flow Cadence access node URL — used to resolve Cadence→COA when inputType is "cadence".
   * Defaults to FLOW_CADENCE_ACCESS (testnet) when omitted.
   */
  flowAccessNode?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CADENCE_ADDR_RE = /^0x[a-fA-F0-9]{16}$/;
const EVM_ADDR_RE     = /^0x[a-fA-F0-9]{40}$/;

// Minimal ABI surface for MemoKeyRegistry
const MEMO_REGISTRY_ABI = new ethers.Interface([
  "function getMemoKey(address user) view returns (uint256 x, uint256 y, uint256 publishedAt)",
]);

// Cadence script — read COA EVM address via published /public/evm capability.
const SCRIPT_GET_COA_EVM = `
import EVM from 0x8c5303eaa26202d6
access(all) fun main(addr: Address): String {
    let acct = getAccount(addr)
    let coa = acct.capabilities.borrow<&EVM.CadenceOwnedAccount>(/public/evm)
      ?? panic("No COA at /public/evm for ".concat(addr.toString()))
    return coa.address().toString()
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise to lowercase 0x-prefixed. */
function normalise(addr: string): string {
  const t = addr.trim();
  return t.startsWith("0x") ? `0x${t.slice(2).toLowerCase()}` : `0x${t.toLowerCase()}`;
}

/** Sniff address type from the input string. */
function sniffType(normalised: string): "cadence" | "evm" | null {
  if (CADENCE_ADDR_RE.test(normalised)) return "cadence";
  if (EVM_ADDR_RE.test(normalised)) return "evm";
  return null;
}

/**
 * Resolve Cadence address → COA EVM address using FCL script query.
 * Throws if the account has no published /public/evm capability.
 */
async function resolveCadenceToCoaEvm(
  cadenceAddress: string,
  accessNode: string,
): Promise<string> {
  const fcl = await import("@onflow/fcl");
  // Configure FCL access node for this call (idempotent if already configured to same node)
  fcl.config({ "accessNode.api": accessNode });

  const result = (await fcl.query({
    cadence: SCRIPT_GET_COA_EVM,
    args: (arg: unknown, typeOf: unknown) => [
      // @ts-expect-error FCL types are dynamic
      arg(cadenceAddress, typeOf.Address),
    ],
  })) as string;

  if (!result || result === "") {
    throw new Error(
      `resolveRecipient: Cadence account ${cadenceAddress} has no COA at /public/evm. ` +
      `They must run the COA setup transaction before receiving tips.`,
    );
  }
  return result.startsWith("0x") ? result : `0x${result}`;
}

/**
 * Query MemoKeyRegistry for a given EVM address.
 * Returns null when the address has not activated (getMemoKey returns (0, 0, *)).
 */
async function queryMemoKey(
  evmAddress: string,
  registryAddr: string,
  rpc: string,
): Promise<{ pubkeyX: bigint; pubkeyY: bigint } | null> {
  const provider = new ethers.JsonRpcProvider(rpc);
  const calldata = MEMO_REGISTRY_ABI.encodeFunctionData("getMemoKey", [evmAddress]);
  const raw = await provider.call({ to: registryAddr, data: calldata });
  if (!raw || raw === "0x") return null;

  const [x, y] = MEMO_REGISTRY_ABI.decodeFunctionResult("getMemoKey", raw);
  const pubkeyX = BigInt(x);
  const pubkeyY = BigInt(y);
  if (pubkeyX === 0n && pubkeyY === 0n) return null;
  return { pubkeyX, pubkeyY };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Resolve a recipient address into a unified ResolvedRecipient.
 *
 * @param input        Raw address string (Cadence 8-byte or EVM 20-byte, 0x-prefixed hex).
 * @param expectedType Expected address type. "any" accepts both. Throws when mismatch.
 * @param opts         Network options (RPC, registry address, optional Cadence access node).
 */
export async function resolveRecipient(
  input: string,
  expectedType: "cadence" | "evm" | "any",
  opts: ResolveRecipientOpts,
): Promise<ResolvedRecipient> {
  const normalised = normalise(input);
  const inputType = sniffType(normalised);

  if (!inputType) {
    throw new Error(
      `resolveRecipient: unrecognised address format "${input}". ` +
      `Expected either a Cadence address (0x + 16 hex chars) or an EVM address (0x + 40 hex chars).`,
    );
  }

  // Type guard
  if (expectedType !== "any" && inputType !== expectedType) {
    const typeNames: Record<string, string> = {
      cadence: "Cadence (0x + 16 hex chars)",
      evm: "EVM (0x + 40 hex chars)",
    };
    throw new Error(
      `resolveRecipient: address type mismatch. Expected ${typeNames[expectedType]} ` +
      `but received a ${inputType} address "${input}".`,
    );
  }

  const accessNode = opts.flowAccessNode ?? FLOW_CADENCE_ACCESS;

  // ── Resolve EVM COA address ──────────────────────────────────────────────
  let evmCoaAddress: string;
  let cadenceAddress: string | undefined;

  if (inputType === "evm") {
    evmCoaAddress = ethers.getAddress(normalised); // EIP-55 checksum
  } else {
    // Cadence address → resolve COA EVM on-chain
    cadenceAddress = normalised;
    evmCoaAddress = await resolveCadenceToCoaEvm(cadenceAddress, accessNode);
    evmCoaAddress = ethers.getAddress(evmCoaAddress); // EIP-55 checksum
  }

  // ── Query MemoKeyRegistry ────────────────────────────────────────────────
  const memoKey = await queryMemoKey(evmCoaAddress, opts.memoKeyRegistryAddr, opts.rpc);

  return {
    inputType,
    inputNormalized: normalised,
    cadenceAddress,
    evmCoaAddress,
    memoKey,
    isActivated: memoKey !== null,
  };
}
