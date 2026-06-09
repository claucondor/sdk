/**
 * inbox/ — ShieldedInboxClient for EVM ShieldedInbox contract (v0.8).
 *
 * The ShieldedInbox replaces event-scanning for incoming note discovery.
 * Notes are deposited atomically during shieldedTransfer by the token contract.
 *
 * @example
 *   import { ShieldedInboxClient } from '@claucondor/sdk/inbox';
 *   const inbox = new ShieldedInboxClient();
 *   const { decrypted, txHash } = await inbox.drainAndDecrypt(signer, memoPrivKey);
 *   for (const { content } of decrypted) {
 *     console.log('received:', content.amount, 'blinding:', content.blinding);
 *   }
 */

export { ShieldedInboxClient } from "./ShieldedInboxClient";
export type { DrainResult, DrainAndDecryptResult, CheckpointMetadata } from "./ShieldedInboxClient";
