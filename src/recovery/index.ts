/**
 * @openjanus/sdk/recovery — Shielded state recovery module (v0.5.2).
 *
 * Provides tools to reconstruct a user's shielded (balance, blinding) pair
 * from encrypted snapshot events emitted by JanusFlow.sol v0.5.2. This is
 * the universal recovery channel for both Cadence-integrated apps (PrivateTip)
 * and pure Flow EVM users with no Cadence account.
 *
 * Usage:
 *
 *   import { recovery } from "@openjanus/sdk";
 *   // or:
 *   import { scanJanusFlowSnapshots, decryptSnapshot, reconstructFromSnapshots }
 *     from "@openjanus/sdk/recovery";
 *
 *   // 1. Scan on-chain events for snapshot blobs addressed to the user.
 *   const raw = await recovery.scanJanusFlowSnapshots(myEvmAddr, provider);
 *
 *   // 2. Decrypt each blob with the user's memo privkey.
 *   const snapshots = (await Promise.all(
 *     raw.map(async r => {
 *       const dec = await recovery.decryptSnapshot(r.ciphertext, r.ephPubkey, privkey);
 *       if (!dec) return null;
 *       return { ...dec, timestamp: r.timestamp, txHash: r.txHash };
 *     })
 *   )).filter(Boolean);
 *
 *   // 3. Fetch on-chain commitment.
 *   const commit = await recovery.readJanusFlowCommitment(myEvmAddr, provider);
 *
 *   // 4. Reconstruct + validate.
 *   const state = await recovery.reconstructFromSnapshots({
 *     snapshots,
 *     incomingDeltas: [],   // pass ShieldedNote deltas received from others
 *     onChainCommit: commit,
 *   });
 *   console.log(state.balanceWei, state.blinding);
 */

export * from "./types";
export * from "./snapshot";
export * from "./scanner";
export * from "./validate";
export * from "./reconstruct";
