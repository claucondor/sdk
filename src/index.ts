/**
 * @claucondor/sdk — v0.6.0
 *
 * Multi-token SDK for OpenJanus confidential tokens on Flow.
 *
 * v0.6 architecture:
 *   adapters/      — JanusTokenAdapter interface + 3 generic variant implementations
 *   orchestration/ — ALL crypto + ordering logic (wrap/shieldedTransfer/unwrap)
 *   crypto/        — ECIES, snapshot-schema, note-schema, memokey derivation, proof builders
 *   proof/         — Groth16 wrappers + pi_b swap
 *   network/       — EVM/Cadence clients + TOKEN_REGISTRY
 *   scan/          — Event scanner + latest-snapshot reconstruction
 *
 * Entry point:
 *   import { sdk } from '@claucondor/sdk';
 *   const flow = sdk.token('flow');
 *   const wflow = sdk.token('wflow');
 *   const mockusdc = sdk.token('mockusdc');
 *   const mockft = sdk.token('mockft');
 *
 * Frontend stays dumb — all orchestration (gross→net→proof→encrypt→tx) is inside
 * each adapter, delegating to src/orchestration/*.
 */

import { TOKEN_REGISTRY, type TokenId } from "./network/contracts";
import { JanusFlowAdapter } from "./adapters/janus-flow";
import { JanusERC20Adapter } from "./adapters/janus-erc20";
import { JanusFTAdapter } from "./adapters/janus-ft";
import type { JanusTokenAdapter } from "./adapters/JanusTokenAdapter";

// ---------------------------------------------------------------------------
// sdk — the primary entry point
// ---------------------------------------------------------------------------

// Singleton adapter cache (one per token id, created lazily)
const _adapters = new Map<TokenId, JanusTokenAdapter>();

function buildAdapter(id: TokenId): JanusTokenAdapter {
  const entry = TOKEN_REGISTRY[id];
  switch (entry.variant) {
    case "native":
      return new JanusFlowAdapter(id, entry);
    case "erc20":
      return new JanusERC20Adapter(id, entry);
    case "cadence-ft":
      return new JanusFTAdapter(id, entry);
  }
}

export const sdk = {
  /**
   * Get the adapter for a specific token.
   *
   * @param id  Token identifier: 'flow' | 'wflow' | 'mockusdc' | 'mockft'
   * @returns   JanusTokenAdapter for this token
   *
   * @example
   *   const adapter = sdk.token('flow');
   *   await adapter.publishMemoKey(keypair, signer);
   *   await adapter.wrap({ grossAmount: 5n * 10n**18n }, signer);
   */
  token(id: TokenId): JanusTokenAdapter {
    if (!_adapters.has(id)) {
      _adapters.set(id, buildAdapter(id));
    }
    return _adapters.get(id)!;
  },

  /**
   * List all registered token IDs.
   */
  tokens(): TokenId[] {
    return Object.keys(TOKEN_REGISTRY) as TokenId[];
  },
} as const;

// ---------------------------------------------------------------------------
// Convenience re-exports for advanced users and test code
// ---------------------------------------------------------------------------

// Token registry + addresses
export { TOKEN_REGISTRY, VERIFIERS, FLOW_EVM_RPC, FLOW_CADENCE_ACCESS } from "./network/contracts";
export type { TokenId } from "./network/contracts";

// Adapter interface + classes
export type { JanusTokenAdapter, EVMSigner } from "./adapters/JanusTokenAdapter";
export { JanusFlowAdapter } from "./adapters/janus-flow";
export { JanusERC20Adapter } from "./adapters/janus-erc20";
export { JanusFTAdapter } from "./adapters/janus-ft";

// Types
export type {
  BabyJubKeypair,
  TokenVariant,
  WrapParams,
  WrapResult,
  SendParams,
  SendResult,
  UnwrapParams,
  UnwrapResult,
  TxResult,
  DepositRecord,
  NoteContent,
  SnapshotContent,
} from "./types";
export { SNAPSHOT_TIMESTAMP_UNIT } from "./types";

// Crypto primitives
export { deriveMemoKeyFromSignature, MEMO_KEY_CONTEXT } from "./crypto/memokey";
export { deriveBabyJubKeypairFromBytes } from "./crypto/derive-keypair";
export { encryptSnapshot, decryptSnapshot } from "./crypto/snapshot-schema";
export { encryptNote, decryptNote } from "./crypto/note-schema";
export { encryptShieldedNote, decryptShieldedNote } from "./crypto/shielded-note";
export type { ShieldedNote } from "./crypto/shielded-note";
export { decryptAnyNote } from "./crypto/decrypt-any-note";
export type { DecryptedAnyNote } from "./crypto/decrypt-any-note";
export { generateBlinding } from "./crypto/commitment";
export { generateBabyJubKeypair, pubkeyFromPrivkey, computeSharedSecret } from "./crypto/babyjub-keypair";

// Proof builders (for advanced callers or off-chain proof generation)
export { buildAmountDiscloseProof } from "./crypto/amount-disclose";
export type { AmountDiscloseProofInput, AmountDiscloseProofResult } from "./crypto/amount-disclose";
export { buildShieldedTransferProof } from "./crypto/shielded-transfer";
export type { ShieldedTransferProofInput, ShieldedTransferProofResult } from "./crypto/shielded-transfer";

// Pi-b swap (required for snarkjs→EVM and snarkjs→Cadence proof packing)
export { applyPiBSwap, evmProofToUint256Array } from "./utils/pi-b-swap";

// JSON serialization helper — use with JSON.stringify to handle BigInt fields
export { bigintReplacer } from "./utils/format";

// Network helpers
export { createEvmProvider, createEvmWallet, configureFCL, NETWORK_CONFIG } from "./network/flow-client";
export type { FlowNetwork } from "./network/flow-client";

// Orchestration (for custom adapter authors)
export { orchestrateWrap, randomNonce256 } from "./orchestration/wrap";
export type { WrapOrchestrateInput, WrapOrchestrateResult } from "./orchestration/wrap";
export { orchestrateShieldedTransfer } from "./orchestration/shielded-transfer";
export type { ShieldedTransferOrchestrateInput, ShieldedTransferOrchestrateResult } from "./orchestration/shielded-transfer";
export { orchestrateUnwrap } from "./orchestration/unwrap";
export type { UnwrapOrchestrateInput, UnwrapOrchestrateResult } from "./orchestration/unwrap";

// Scan helpers
export { scanSnapshots, scanIncomingNotes } from "./scan/event-scanner";
export { getLatestSnapshot, getLatestSnapshotWithBlock } from "./scan/latest-snapshot";
export type { LatestSnapshotResult } from "./scan/latest-snapshot";

// Fee helpers (pure math, no provider)
export {
  computeNetWrap,
  computeWrapFee,
  computeNetUnwrap,
  computeUnwrapFee,
} from "./crypto/fee-math";

// Pedersen commitment helpers
export { computeCommitment, addCommitmentsLocal, subCommitmentsLocal } from "./primitives/pedersen";

// COA helpers (for cross-VM setup)
export {
  KNOWN_COAS,
  getKnownCOA,
  getCOAAddressOnChain,
  getCoaEvmAddress,
  hasCOA,
  getCoaBalanceWei,
  getFlowVaultBalanceWei,
} from "./network";
