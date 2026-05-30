/**
 * @openjanus/sdk — v0.4
 *
 * Generic, app-agnostic SDK for OpenJanus confidential token primitives on Flow.
 *
 * v0.4 highlights (additive over v0.3 — NO breaking changes):
 *   - JanusERC20 (ERC20-wrapping confidential token on Flow EVM) — same
 *     shielded-transfer privacy as JanusFlow, with an explicit
 *     amount + approve-and-pull boundary instead of payable msg.value.
 *     Ships pinned to a permissionlessly-mintable MockUSDC underlying so
 *     apps can develop against a stable 6-decimal token address even though
 *     Flow EVM testnet lacks canonical USDC.
 *   - JanusFT (Cadence-side wrapper for any FungibleToken vault) — lab-grade
 *     port. Same STRUCTURAL privacy SHAPE as JanusERC20 (calldata + events +
 *     storage), with stub babyAdd/babyNegate and opaque proof acceptance.
 *     Real soundness lands in v0.5 once cross-VM BabyJub.sol calls land.
 *   - All v0.3 exports retained — apps using JanusFlow keep working unchanged.
 *
 * v0.3 highlights (retained):
 *   - JanusFlow (native FLOW confidential token) — fully shielded transfers,
 *     leaks only at the wrap/unwrap boundary by design.
 *   - JanusToken abstract base — ready for ERC-20 / cross-asset extensions.
 *   - Generic crypto helpers — buildAmountDiscloseProof, buildShieldedTransferProof.
 *   - Bundled Groth16 artifacts in circuits/v0.3/ (Hermez pot14 + Flow VRF beacon).
 *
 * Module hierarchy:
 *   types/      — Shared TypeScript types (no runtime code)
 *   utils/      — Pure utilities (hex, pi_b swap)
 *   primitives/ — Low-level crypto (BabyJub, Pedersen, Groth16)
 *   network/    — Flow client + COA management
 *   crypto/     — High-level crypto operations (commitments, proofs)
 *   tokens/     — JanusToken (abstract) + JanusFlow + JanusERC20 + JanusFT
 *
 * See MIGRATION-v0.4.md (additive — no breaking changes) and MIGRATION-v0.3.md.
 */

// ---------------------------------------------------------------------------
// Token primitives — generic confidential tokens (v0.4 multi-token)
// ---------------------------------------------------------------------------
export {
  JanusToken,
  JanusFlow,
  JanusFlowCadence,
  JanusERC20,
  JanusFTCadence,
  JANUS_TOKEN_BASE_ABI,
  JANUS_BABYJUB_ADDRESS,
  AMOUNT_DISCLOSE_VERIFIER,
  CONFIDENTIAL_TRANSFER_VERIFIER,
  JANUS_TOKEN_OWNER_EVM,
  // JanusFlow (v0.3)
  JANUS_FLOW_TESTNET,
  JANUS_FLOW_EVM_ADDRESS,
  JANUS_FLOW_EVM_IMPL_ADDRESS,
  JANUS_FLOW_CADENCE_ADDRESS,
  JANUS_FLOW_CONTRACT_NAME,
  JANUS_FLOW_VERSION,
  JANUS_FLOW_MAX_WRAP_ATTOFLOW,
  // JanusERC20 (v0.4)
  JANUS_ERC20_TESTNET,
  JANUS_ERC20_EVM_ADDRESS,
  JANUS_ERC20_EVM_IMPL_ADDRESS,
  JANUS_ERC20_MOCK_USDC_ADDRESS,
  JANUS_ERC20_VERSION,
  JANUS_ERC20_MAX_WRAP_RAW,
  JANUS_ERC20_EXTRA_ABI,
  ERC20_MINIMAL_ABI,
  // JanusFT (v0.4)
  JANUS_FT_CADENCE_ADDRESS,
  JANUS_FT_CONTRACT_NAME,
  JANUS_FT_VERSION,
  JANUS_FT_DEFAULT_UNDERLYING_TYPE,
  JANUS_FT_SMOKE_MIRROR_ADDRESS,
  TX_FT_SETUP_REGISTRY,
  TX_FT_WRAP,
  TX_FT_SHIELDED_TRANSFER,
  TX_FT_UNWRAP,
  SCRIPT_FT_GET_TOTAL_LOCKED,
  SCRIPT_FT_GET_COMMITMENT,
  SCRIPT_FT_GET_UNDERLYING_TYPE,
  buildJanusFTTx,
} from "./tokens";
export type {
  JanusTokenOptions,
  JanusFlowCadenceOptions,
  JanusFlowConstructorOptions,
  JanusERC20ConstructorOptions,
  JanusFTCadenceOptions,
  TokenOptions,
  TokenDeployment,
} from "./tokens";

// ---------------------------------------------------------------------------
// Crypto operations — for advanced app code and integrators
// ---------------------------------------------------------------------------
export {
  // Pedersen commitment helpers
  computeCommitment,
  addCommitments,
  negateCommitment,
  identityCommitment,
  isIdentityCommitment,
  generateBlinding,
  decryptBalance,
  // v0.3 proof builders
  buildAmountDiscloseProof,
  buildShieldedTransferProof,
  // BabyJub randomness + FLOW unit helpers
  randomBabyJubScalar,
  flowToWei,
  weiToFlow,
  parseFlowToWei,
  formatWeiToFlow,
  weiToFlowUFix64,
  assertWholeFlow,
  FLOW_DECIMALS,
  FLOW_SCALE,
  // v0.4.1 memo encryption primitives (generic ECIES)
  generateBabyJubKeypair,
  pubkeyFromPrivkey,
  computeSharedSecret,
  encryptText,
  decryptText,
  // v0.4.5 deterministic BabyJub keypair derivation (sign-derive pattern)
  deriveBabyJubKeypairFromBytes,
  // v0.4.4 shielded note (protocol payload, see crypto/shielded-note.ts)
  encryptShieldedNote,
  decryptShieldedNote,
  // v0.5.2 — 128-bit Pedersen commitment (for recovery validation)
  computeCommitmentV05,
} from "./crypto";
export type {
  CommitmentXY,
  AmountDiscloseProofInput,
  AmountDiscloseProofResult,
  ShieldedTransferProofInput,
  ShieldedTransferProofResult,
  ProofArtifactOptions,
  BabyJubKeypair,
  MemoCiphertext,
  ShieldedNote,
} from "./crypto";

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------
export { NETWORK_CONFIG, createEvmProvider, createEvmWallet, configureFCL } from "./network";
export type { FlowNetwork } from "./network";

// COA helpers (v0.4.1 additive)
export {
  KNOWN_COAS,
  SCRIPT_GET_COA_ADDRESS,
  TX_SETUP_COA,
  getKnownCOA,
  getCOAAddressOnChain,
  getCoaEvmAddress,
  hasCOA,
  getCoaBalanceWei,
  getFlowVaultBalanceWei,
} from "./network";

// Utility formatters / validators (v0.4.1 additive)
export {
  formatPoint,
  isValidFlowAddress,
  isValidFlowAmount,
} from "./utils";

// JanusFlow helpers exposed at root (v0.4.1 additive: calldata builders,
// static EVM reads, wrap source resolver, COA-source TX templates).
export {
  TX_WRAP,
  TX_WRAP_FROM_COA,
  TX_SHIELDED_TRANSFER,
  TX_UNWRAP,
  TX_UNWRAP_TO_VAULT,
  buildWrapCalldata,
  buildShieldedTransferCalldata,
  buildUnwrapCalldata,
  readCommitment,
  readTotalLocked,
  resolveWrapSource,
} from "./tokens";
export type {
  WrapSource,
  ResolveWrapSourceInput,
  ResolveWrapSourceResult,
  ResolveWrapSourceOk,
  ResolveWrapSourceError,
} from "./tokens";

// ---------------------------------------------------------------------------
// Module namespaces — for power users and extension authors
// ---------------------------------------------------------------------------
export * as primitives from "./primitives";
export * as network from "./network";
export * as utils from "./utils";

// v0.5.2 — Recovery module: reconstruct shielded state from snapshot events
export * as recovery from "./recovery";

// ---------------------------------------------------------------------------
// Shared types — import these for TypeScript type annotations
// ---------------------------------------------------------------------------
export type {
  Point,
  CommitmentXY as CommitmentPoint,
} from "./types/commitment";
export { CURVE_P, IDENTITY_POINT, isIdentityPoint } from "./types/commitment";

export type {
  SnarkJSProof,
  EVMProof,
  ProofUint256,
  PublicInputsUint256,
} from "./types/proof";
