/**
 * utils/evm-helpers.ts — EVM encoding and address utilities for cross-VM calls.
 *
 * Promoted from private-tip-v1/web/lib/tip-actions.ts (lines 879, 1133, 1404).
 * These helpers recur at every callsite that bridges between Cadence FT tokens
 * (8-byte addresses) and EVM contracts (20-byte addresses), and at every callsite
 * that pre-encodes ABI calldata for fixed-size array functions.
 *
 * @module @claucondor/sdk/utils
 */

import { ethers } from "ethers";

/**
 * Convert a Cadence FT contract address (8 bytes / 16 hex chars) to the
 * zero-padded 20-byte EVM address that the Janus system uses as the token
 * identifier in ShieldedCheckpoint and ShieldedInbox.
 *
 * Context: JanusFT tokens live in Cadence; their 8-byte Cadence contract address
 * is used as a surrogate "EVM token address" in the checkpoint slot key by
 * zero-padding to 20 bytes. Every callsite that passes a token identifier to
 * ShieldedCheckpoint.update() or reads a note's depositor field must use this
 * padded form. Mis-padding = wrong checkpoint slot key → checkpoint read returns
 * no data even when a slot exists.
 *
 * @param cadenceAddr  Cadence address string. Accepts:
 *   - "0x4b6bc58bc8bf5dcc"  (with 0x prefix)
 *   - "4b6bc58bc8bf5dcc"    (without 0x prefix)
 * @returns 20-byte EVM address string with 0x prefix e.g.
 *   "0x0000000000000000000000004b6bc58bc8bf5dcc"
 *
 * @example
 *   cadenceAddrToEvmToken("0x4b6bc58bc8bf5dcc")
 *   // "0x0000000000000000000000004b6bc58bc8bf5dcc"
 */
export function cadenceAddrToEvmToken(cadenceAddr: string): string {
  const stripped = cadenceAddr.replace(/^0x/i, "");
  return "0x" + stripped.padStart(40, "0");
}

/**
 * Pre-encode an EVM function call as ABI calldata, stripping the 0x prefix.
 *
 * Use this to produce a hex string that can be passed as a `String` argument
 * to a Cadence transaction that calls an EVM function via COA. The Cadence side
 * then calls `.decodeHex()` on the string to get raw bytes.
 *
 * WHY: Solidity functions with fixed-size array parameters (e.g. `uint256[6]`,
 * `uint256[8]`) require the ABI to encode them as fixed-size, not dynamic.
 * When Cadence passes `[UInt256]` (a dynamic array) via `EVM.encodeABIWithSignature`,
 * it encodes as `uint256[]` (dynamic array), which is a different ABI encoding
 * than `uint256[6]` / `uint256[8]` → the Solidity function decodes garbage and
 * typically reverts. Pre-encoding with ethers avoids the mismatch entirely.
 *
 * @param iface  An ethers.Interface instance with the function ABI.
 * @param fn     Function name (e.g. "claimBatch").
 * @param args   Arguments in the order the function expects them.
 * @returns      Hex-encoded calldata WITHOUT the 0x prefix (ready for Cadence `String`).
 *
 * @example
 *   const iface = new ethers.Interface([
 *     "function claimBatch(uint256[6] calldata publicInputs, uint256[8] calldata proof)"
 *   ]);
 *   const hex = encodeEVMCalldata(iface, "claimBatch", [publicInputs, proof]);
 *   // → "c94ae..."  (no 0x prefix)
 *   // Pass as: arg(hex, t.String)  in FCL mutate args
 */
export function encodeEVMCalldata(
  iface: ethers.Interface,
  fn: string,
  args: unknown[],
): string {
  const calldata = iface.encodeFunctionData(fn, args);
  return calldata.startsWith("0x") ? calldata.slice(2) : calldata;
}
