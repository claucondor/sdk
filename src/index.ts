/**
 * @claucondor/sdk — v0.8.0
 *
 * Multi-token SDK for OpenJanus confidential tokens on Flow.
 *
 * v0.8 architecture:
 *   adapters/      — JanusTokenAdapter interface + 3 generic variant implementations
 *   orchestration/ — ALL crypto + ordering logic (wrap/shieldedTransfer/unwrap)
 *   crypto/        — ECIES, note-helpers, checkpoint-schema, memokey derivation, proof builders
 *   proof/         — Groth16 wrappers + pi_b swap
 *   network/       — EVM/Cadence clients + TOKEN_REGISTRY
 *   inbox/         — ShieldedInboxClient (state recovery — replaces scan/)
 *   checkpoint/    — ShieldedCheckpointClient (sender-side encrypted state store)
 *   cadence/       — Cadence transaction templates for inbox/checkpoint operations
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
export { TOKEN_REGISTRY, VERIFIERS, FLOW_EVM_RPC, FLOW_CADENCE_ACCESS, TOKEN_RECIPIENT_TYPES } from "./network/contracts";
export type { TokenId, TokenRecipientTypes } from "./network/contracts";

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
  InboxNote,
  NoteContent,
  SnapshotContent,
  CheckpointPayload,
} from "./types";
export { SNAPSHOT_TIMESTAMP_UNIT } from "./types";

// Crypto primitives
export { deriveMemoKeyFromSignature, MEMO_KEY_CONTEXT } from "./crypto/memokey";
export { deriveBabyJubKeypairFromBytes } from "./crypto/derive-keypair";
export { encryptSnapshot, decryptSnapshot } from "./crypto/snapshot-schema";
export { encryptNote, decryptNote } from "./crypto/note-schema";
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

// ── Promoted workarounds (v08-workarounds-promoted) ──────────────────────────

// W3 — UFix64 conversion helpers
// rawToUFix64(amount, decimals) is the generic form; flowToUFix64 wraps it for FLOW (18 dec)
// toUFix64 is @deprecated alias for flowToUFix64
export { rawToUFix64, flowToUFix64, toUFix64, FLOW_SCALE } from "./utils/ufix64";

// W2 — Cadence FT address → 20-byte EVM token identifier
export { cadenceAddrToEvmToken } from "./utils/evm-helpers";

// W7 — ABI fixed-array calldata pre-encoder (avoids Cadence [UInt256]→uint256[N] ABI mismatch)
export { encodeEVMCalldata } from "./utils/evm-helpers";

// W1 — Identity-point detection for admin-reset commitment slots
export { isFreshSlotCommit } from "./utils/fresh-slot";

// W5 — Accumulate pending note deltas onto stale checkpoint for correct C_old in claim proofs
export { computeActualCOld } from "./utils/fresh-slot";

// W8 — JanusFT pB pre-swap: converts EVM-ordered ProofUint256 to Cadence natural-order pA/pB/pC
// JanusFT.wrapWithProof does an internal Fp2-swap; this un-swaps first so the net result is correct.
export { buildFtWrapProofArgs } from "./adapters/janus-ft";

// ── Session helpers (browser-only) ───────────────────────────────────────────
// W4 — MemoKeySession: session-scoped BabyJub privkey cache (sessionStorage)
// W6 — SentMemoStore:  sender-side plaintext memo mirror (localStorage)
// These are re-exported here for discoverability; the dedicated subpath
// @claucondor/sdk/session is the preferred import for apps that tree-shake.
export {
  MemoKeySession,
  getCachedMemoPrivkey,
  cacheMemoPrivkey,
  clearMemoPrivkeyCache,
  SentMemoStore,
  saveSentMemo,
  findSentMemo,
  clearSentMemos,
} from "./session/index";
export type { SentMemoEntry } from "./session/SentMemoStore";

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

// Inbox + Checkpoint clients (v0.8 — replace scan/)
export { ShieldedInboxClient } from "./inbox/ShieldedInboxClient";
export type { DrainResult, DrainAndDecryptResult } from "./inbox/ShieldedInboxClient";

// Cadence inbox reader (v0.8.2 — JanusFT/MockFT notes stored in Cadence ShieldedInbox)
export { getCadenceInboxNotes } from "./inbox/CadenceInboxClient";
export type { CadenceInboxNote } from "./inbox/CadenceInboxClient";
export { ShieldedCheckpointClient } from "./checkpoint/ShieldedCheckpointClient";
export type { CheckpointMetadata, RawCheckpoint, UpdateResult } from "./checkpoint/ShieldedCheckpointClient";

// BatchClaimClient (v0.8.1 — batch consolidation of ShieldedInbox notes)
export { BatchClaimClient } from "./batchClaim/BatchClaimClient";
export type { BuildAndClaimParams, BuildAndClaimResult } from "./batchClaim/BatchClaimClient";
export { buildBatchClaimProof } from "./proof/batch-claim";
export type { BatchClaimInputs, BatchClaimProof, BatchClaimProofOptions } from "./proof/batch-claim";

// Cadence transaction templates (v0.8)
export { cadenceTx, installInbox, installCheckpoint, installInboxAndCheckpoint, updateCheckpointViaCoa, combinedShieldedTransferWithCheckpoint } from "./cadence/index";

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

// Portfolio view helper (v0.8.2 — multi-token drift detector)
export { getPortfolioView } from "./portfolio/getPortfolioView";
export type {
  PortfolioView,
  TokenPortfolioView,
  GetPortfolioViewOpts,
} from "./portfolio/getPortfolioView";

// Identity helpers (v0.8.2 — cross-VM recipient resolution)
export { resolveRecipient } from "./identity/resolveRecipient";
export type { ResolvedRecipient, ResolveRecipientOpts } from "./identity/resolveRecipient";

// Safety guards (v0.8.2 — pre-flight commitment coherence checks)
// Use assertCheckpointMatchesCommit for hard pre-flight (throws on divergence).
// Use isOpSafeNow for soft gating (returns OpSafetyResult, never throws).
// Use safeBuild* wrappers to gate specific op types before proof build.
export {
  assertCheckpointMatchesCommit,
  CheckpointDivergenceError,
  isOpSafeNow,
  safeBuildWrapProof,
  safeBuildSendProof,
  safeBuildClaimProof,
  safeBuildUnwrapProof,
} from "./safety/index";
export type {
  AssertCheckpointOpts,
  OpType,
  SuggestedAction,
  OpSafetyResult,
  SafeProofOpts,
} from "./safety/index";

// MockFT vault version detection + reinstall tx (v08-workarounds-promoted)
export { checkMockFTVaultVersion } from "./cadence/mockft-vault";
export { reinstallMockFTVault, reinstallAllJanusResources } from "./cadence/atomic-transactions";

// Janus resources status check + general reinstall (resource-check)
export { checkJanusResourcesStatus } from "./cadence/resource-check";
export type { ResourcesStatus, ResourceStatus } from "./cadence/resource-check";
