/**
 * recovery/validate.ts — Validate a reconstructed state against the on-chain
 * Pedersen commitment.
 *
 * Uses computeCommitmentV05 (the v0.5+ 128-bit Pedersen scheme) to verify
 * that the recovered (balance, blinding) pair reproduces the on-chain point.
 */

import { ethers } from "ethers";
import { computeCommitmentV05 } from "../primitives/pedersen";

const JANUS_FLOW_DEFAULT_ADDR = "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078";

/**
 * Read the user's on-chain Pedersen commitment from the JanusFlow proxy.
 * Uses the `commitments(address)` mapping which returns (x, y) as a struct.
 */
export async function readJanusFlowCommitment(
  userEvmAddr: string,
  provider: ethers.Provider,
  janusFlowAddr: string = JANUS_FLOW_DEFAULT_ADDR
): Promise<{ x: bigint; y: bigint }> {
  const abi = ["function commitments(address) view returns (uint256, uint256)"];
  const contract = new ethers.Contract(janusFlowAddr, abi, provider);
  const [x, y] = await contract.commitments(userEvmAddr);
  return { x: BigInt(x), y: BigInt(y) };
}

/**
 * Verify that (balance, blinding) reproduces the expected on-chain commitment.
 *
 * Returns `true` if the Pedersen commitment of (balance, blinding) matches
 * `expectedCommit`. A `false` return indicates state desync — either
 * snapshots are missing (activity before snapshot events were enabled),
 * or the incoming deltas are incomplete.
 */
export async function validatePedersenCommit(
  balance: bigint,
  blinding: bigint,
  expectedCommit: { x: bigint; y: bigint }
): Promise<boolean> {
  const computed = await computeCommitmentV05(balance, blinding);
  return computed.x === expectedCommit.x && computed.y === expectedCommit.y;
}
