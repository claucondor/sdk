# Changelog

---

## 0.8.1-alpha.6 (2026-06-11) — Multi-token ShieldedCheckpoint + atomic templates moved from frontend

### Breaking Changes

- **`ShieldedCheckpointClient.update()`**: signature changed from `update(payload, cursor, signer)` to `update(token, payload, cursor, signer)`. The `token` arg is the EVM proxy address of the Janus token being checkpointed (e.g. `TOKEN_REGISTRY.flow.proxy` for FLOW). Without it the call will fail.
- **`ShieldedCheckpointClient.read()`**: was `read(signer)`, now `read(token, signer)`. Returns `null` instead of throwing when no checkpoint exists (`NoCheckpoint` revert is caught).
- **`ShieldedCheckpointClient.readAndDecrypt()`**: was `readAndDecrypt(signer, memoPrivKey)`, now `readAndDecrypt(token, signer, memoPrivKey)`.
- **`ShieldedCheckpointClient.metadata()`**: was `metadata(user)`, now `metadata(user, token)`.
- **`ShieldedCheckpointClient.exists()`**: was `exists(user)`, now `exists(user, token)`.
- **`ShieldedCheckpointClient.encryptAndUpdate()`**: was `encryptAndUpdate(snapshot, cursor, kp, signer)`, now `encryptAndUpdate(token, snapshot, cursor, kp, signer)`.
- **`cadenceTx.updateCheckpointViaCoa()`**: ABI changed from `update(bytes,uint256,uint256,uint64)` to `update(address,bytes,uint256,uint256,uint64)`. The Cadence transaction now takes `tokenAddrHex: String` as its first arg.
- **`cadenceTx.combinedShieldedTransferWithCheckpoint()`**: same ABI change — checkpoint call now includes token (resolved from `janusFlowAddr`). Also applies `EVM.EVMBytes(value:)` fix to `encryptedNoteTo` calldata.

### New Contract Address

- **`SHIELDED_CHECKPOINT_ADDRESS`**: updated to `0x88C9fD443BC15d1Cd24bc724DB6928D3246b2E26` (v0.8.2 multi-token re-deploy, sprint A.4).
- Old singleton address `0xbF8dbE133FC1319570dBe43E32BFD9a6D64E1E76` preserved as internal `SHIELDED_CHECKPOINT_ADDRESS_ARCHIVE_SINGLETON` (NOT exported).

### Atomic Templates Moved from PrivateTip Frontend

Five Cadence transaction templates moved from `private-tip-v1/web/lib/cadence-tx.ts` into `src/cadence/atomic-transactions.ts`:

- `cadenceTx.wrapFlowAtomic(tokenAddrHex)` — wrap + checkpoint in one tx
- `cadenceTx.sendTipAtomic(tokenAddrHex)` — shieldedTransfer + checkpoint in one tx
- `cadenceTx.unwrapFlowAtomic(tokenAddrHex)` — unwrap + checkpoint in one tx
- `cadenceTx.claimBatchAtomic(tokenAddrHex)` — drainAll + claimBatch + checkpoint in one tx
- `cadenceTx.atomicUpdateCheckpointViaCoa()` — standalone checkpoint update (atomic variant)

All templates:
- Use `EVM.EVMBytes(value: ...)` wrapper for `[UInt8] → bytes` calldata (fixes encoding bug hit in PrivateTip frontend).
- Bake in `SHIELDED_CHECKPOINT_ADDRESS` from SDK constant (auto-updates when SDK is bumped).
- Take `tokenAddrHex` as a JS function argument to parameterize the checkpoint token slot.

### Orchestration Notes

- `orchestrateWrap`, `orchestrateShieldedTransfer`, `orchestrateUnwrap` are unchanged — they return `checkpointPayload` for callers to persist.
- Callers must now pass the token address when calling `checkpoint.update(token, payload, cursor, signer)`.
- Token resolution: `TOKEN_REGISTRY.flow.proxy` for FLOW, `TOKEN_REGISTRY.mockusdc.proxy` for mUSDC.

### MockFT (Cadence FT) Limitation

The Cadence-side `ShieldedCheckpoint` upgrade was blocked in v0.8.2 sprint A.4. MockFT shielded balance is still subject to singleton overwrite on the Cadence side. The EVM checkpoint works correctly for all EVM tokens. Cadence FT checkpoint fix is deferred to a future sprint.

---

## 0.8.1-alpha.2 — 2026-06-10

### Fixed

- Backported runtime fixes from Phase C testnet: `__filename` TDZ in CJS bundle (`dist/index.cjs`, `dist/batchClaim/index.cjs`), robust `PACKAGE_ROOT` artifact resolution via `package.json` walk-up.
- Source-level fix in `src/proof/batch-claim.ts`, `src/crypto/shielded-transfer.ts`, `src/crypto/amount-disclose.ts`; tarball now correct on fresh install (no `node_modules` patching needed).

---

## 0.8.1-alpha.1 — 2026-06-09

### Added

- **`BatchClaimClient`** (`src/batchClaim/BatchClaimClient.ts`): EVM client for `JanusToken.claimBatch`. Aggregates up to 50 ShieldedInbox notes into the caller's shielded balance via a single Groth16 proof. Exports `claimBatch(publicInputs, proof)` for pre-built proofs and `buildAndClaim(params)` for the full generate+submit flow. Also exposes `getVerifierAddress()` and `getVersion()` view helpers.
- **`buildBatchClaimProof`** (`src/proof/batch-claim.ts`): TypeScript port of the `proof-inputs.cjs` accumulation strategy. Pads note arrays to N=50, computes C_old/C_new/C_consumed via chained BabyJubJub point addition (NOT scalar sum), runs `groth16.fullProve`, applies Fp2 swap, and returns EVM-ready `uint256[8]` proof + 6-element public inputs.
- **`batchClaimAndUpdate`** methods on all three token adapters:
  - `JanusFlowAdapter.batchClaimAndUpdate(params, signer)` → delegates to `BatchClaimClient.buildAndClaim`.
  - `JanusERC20Adapter.batchClaimAndUpdate(params, signer)` → delegates to `BatchClaimClient.buildAndClaim`.
  - `JanusFTAdapter.batchClaimAndUpdate(params)` → generates proof off-chain, submits via FCL Cadence tx calling `JanusFT.CommitmentRegistry.claimBatch()` with cross-VM verification.
- 26 new unit tests (2 new test files) covering: C_old/C_new/C_consumed commitment arithmetic, note padding to N=50, pB Fp2 swap, public signal count validation, claimBatch calldata encoding, input validation, contract method delegation.

### Protocol Notes

- v0.8.1 contracts were upgraded via UUPS (proxies unchanged, impls swapped) — no SDK address changes needed. JanusFlow proxy remains `0xA64340C1d356835A2450306Ffd290Ed52c001Ad3`, JanusERC20 proxy remains `0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d`.
- `ConfidentialClaimBatchVerifier` (pot22 ceremony, N=50): `0x2FBf6baef1D70f5A9aFF2602c934Bd62dcf6Df80`.
- Trust assumption (testnet): inbox notes are NOT marked consumed on-chain after `claimBatch`. Replay is bounded by the C_old state machine — post-claim C_old advances to C_new, invalidating any proof that references the prior C_old. Mainnet hardening requires `NoteCommitmentTracker.sol` (deferred to L6/mainnet prep).

---

## 0.8.0-alpha.1 — 2026-06-09

**v0.8 protocol rewrite: inbox/checkpoint replace scan, 6-arg shieldedTransfer, schema-agnostic ECIES.**

### Breaking Changes

- **`shieldedTransfer` ABI**: 9 args → 6 args. `encryptedSnapshotFrom`, `ephPubFromX`, `ephPubFromY` removed from calldata. The sender's checkpoint payload is returned by the SDK and must be submitted separately via `ShieldedCheckpoint.update()`.
- **`scan/` module removed**. Use `ShieldedInboxClient.drainAndDecrypt()` for incoming note discovery. Use `ShieldedCheckpointClient.readAndDecrypt()` for balance recovery.
- **`SnapshotContent`**: `timestampMs` field removed. Shape is now `{balance: bigint, blinding: bigint}` only.
- **`NoteContent`**: `tipId` field removed (was app-specific, not protocol). Apps must carry it externally.
- **`SendResult`**: now returns `checkpointPayload`, `newBalance`, `newBlinding`.

### New Modules

- **`src/inbox/ShieldedInboxClient`**: EVM client for `ShieldedInbox.sol`. Methods: `count`, `peek`, `peekAll`, `drainAll`, `drainBatch`, `drainAndDecrypt`, `deposit`.
- **`src/checkpoint/ShieldedCheckpointClient`**: EVM client for `ShieldedCheckpoint.sol`. Methods: `exists`, `metadata`, `read`, `readAndDecrypt`, `update`, `encryptAndUpdate`.
- **`src/cadence/transactions`**: Cadence transaction templates — `installInbox`, `installCheckpoint`, `installInboxAndCheckpoint`, `updateCheckpointViaCoa`, `combinedShieldedTransferWithCheckpoint`.

### Crypto

- **`src/crypto/note-helpers.ts`** (new): Protocol-canonical note encryption. Wire format: `{v:1, amt, bld, memo?}`.
- **`src/crypto/checkpoint-schema.ts`** (new): Protocol-canonical snapshot encryption. Wire format: `{v:1, bal, bld}`.
- `src/crypto/note-schema.ts` and `snapshot-schema.ts` now re-export from the new canonical files (backward-compat shims).
- `decryptAnyNote`: dropped legacy `{v,a,b,d}` shielded fallback (JanusFT v0.8 now uses canonical format).
- Added `decryptInboxNote(note: InboxNote, privkey: bigint)` convenience function.

### Network

- All Janus Cadence contracts moved to `0x4b6bc58bc8bf5dcc` (was `0xc4e8f99915893a2f`).
- `SHIELDED_INBOX_ADDRESS = "0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6"` (new).
- `SHIELDED_CHECKPOINT_ADDRESS = "0xbF8dbE133FC1319570dBe43E32BFD9a6D64E1E76"` (new).
- `MEMO_REGISTRY_ADDRESS = "0x361bD4d037838A3a9c5408AE465d36077800ee6c"` (was `0x05D104...`).
- `LEGACY_V071_JANUSFLOW_PROXY` preserved for PrivateTip demo reference.
- v0.8 `VERIFIERS`: `transferVerifier = 0x38e69fE7…`, `amountDiscloseVerifier = 0xf7B634…`.

### Tests

- 72 unit tests across 8 test files (all passing).
- Covers: fee-math, note-helpers, checkpoint-schema, decrypt-any-note, pi-b-swap, contract addresses, COA registry, Cadence templates.
- Added comprehensive integration tests against deployed v0.8 testnet stack (32 tests, 5 suites).
  - `ShieldedInboxClient`: count, peek, drainBatch, drainAndDecrypt — wrap → transfer → drain full cycle.
  - `ShieldedCheckpointClient`: encryptAndUpdate, readAndDecrypt, metadata, cursor rewind, SnapshotTooLarge revert.
  - `MemoKeyRegistry`: publishMemoKey, getMemoKey, rotateMemoKey via `JanusFlowAdapter`.
  - `JanusFlowAdapter`: full wrap → shieldedTransfer → checkpoint → drain → unwrap using SDK orchestration layer.
  - `JanusERC20Adapter`: mint → approve → wrap → transfer → drain → decode → unwrap for MockUSDC.
  - Gated by `RUN_INTEGRATION=1` to avoid blocking default `npm test`.
- Added E2E tests via SDK public API only (16 tests, 3 suites).
  - `flow-lifecycle`: FLOW wrap → blinding recovery from `WrapWithSnapshot` event → shieldedTransfer → drain → unwrap.
  - `musdc-lifecycle`: mUSDC mint → approve → wrap → shieldedTransfer → drain → unwrap.
  - `multi-token`: same sender wraps FLOW + mUSDC; sends FLOW to Bob, mUSDC to Carol; isolated inboxes verified.
  - Gated by `RUN_E2E=1`.
- Confirmed compatible with testnet v0.8 stack at Cadence account `0x4b6bc58bc8bf5dcc`.

---

## 0.7.5 — 2026-06-08

**Decrypt API consistency (OF-7), reverse-scan recovery, and rate-limit fix.**

### Crypto

- New `decryptAnyNote(ciphertext, ephPubkey, memoPrivKey)` util — format-agnostic decryption that tries v3 (EVM) first, falls back to shielded (Cadence-FT). Returns `null` if both fail. Use when the token type is unknown at call-site (e.g. mixed-token scanning).
- Every adapter now exposes `decryptIncomingNote(ciphertext, ephPubkey, memoPrivKey)` that calls the correct decoder for its variant — no fallback overhead. `JanusFlowAdapter`/`JanusERC20Adapter` → v3 wire. `JanusFTAdapter` → shielded wire.
- Fixes silent zero-balance recovery bug where mixing decoders returned `null` instead of the real amount (OF-7 — `/api/note/decrypt`-style fallback patterns).

### Scan

- `getLatestSnapshot` rewritten as **reverse-scan + early-exit** (chunk newest blocks first; return on first successful decrypt). 8.6× faster typical, ~5s worst-case vs ~45s forward-scan.
- `getLatestSnapshotWithBlock(...)` exposed — returns `{snapshot, blockNumber}` for chained `scanIncomingNotes` calls.
- `scanSnapshots` no longer makes 3 parallel `getLogs` per chunk — uses a single `getLogs(topics: [null, userTopic])` per chunk. Prevents `>40 req/s` bursts against QuickNode on large historical ranges.

### Tests

- 8 new round-trip tests for `decryptAnyNote` + adapter `decryptIncomingNote` (cross-decoder negative cases included).
- Test suite: 173/173 pass.

---

## 0.6.6 — 2026-06-03

**JanusFTAdapter.getBalance: use contract canonical BalancePublicPath instead of hardcoded path.**

- `src/adapters/janus-ft.ts` line 266: was `/public/${ftContractName}Balance` (PascalCase, breaks MockFT whose path is `/public/mockFTBalance`). Now reads `${ftContractName}.BalancePublicPath` — same pattern as `VaultStoragePath` (wrap) and `ReceiverPublicPath` (unwrap). Works for any FT contract regardless of casing convention.

---

## 0.6.5 — 2026-06-02

README cleanup — `(JanusMockFT)` label corrected to `(JanusFT)` in the Token IDs table.
No functional code change. Use 0.6.5 instead of 0.6.4 for a clean README.

- `README.md` Token IDs table row for `mockft`: `(JanusMockFT)` → `(JanusFT)`

---

## 0.6.4 — 2026-06-03

**JanusFT: Cadence wrapper renamed from JanusMockFT to JanusFT for production-grade naming.**

### Architecture change (Track B+++)

- `JanusFT` is now the canonical Cadence FT wrapper (generic underlying — accepts any `@{FungibleToken.Vault}` at deploy time). `MockFT` remains as the testnet-only underlying; its name is fine (Mock prefix on underlying, not wrapper).
- Upgraded from lab-spike stub (babyAddStub, no real ZK) to full production contract: real cross-VM BabyJub arithmetic via `BabyJub.sol`, real Groth16 ZK verification via `ConfidentialTransferVerifier.sol` + `AmountDiscloseVerifier.sol`.
- `FeeConfig` resource added (upgrade-safe: no new contract-level fields). Includes `feeReceiverPath` for generic underlying FT receiver capability.
- `custodyVaultType()` view function derives the `Type` from the stored `underlyingVaultTypeIdentifier` string via `CompositeType()`.
- Deployed on testnet at `0x7599043aea001283`:
  - update_tx: `c090b6ab36333a0238da3d7b5fc1b5931ca6862d3945779f7abf51947901d768`
  - setup_tx:  `50e3434e72d9e511c24c831fcebd2f3a451357f18b6e27c8255d5ce2b08af3ff`

### SDK changes

- `src/network/contracts.ts`: `mockft` token registry entry `contractName` changed from `'JanusMockFT'` to `'JanusFT'`. Registry key `'mockft'` is stable.
- `src/adapters/janus-ft.ts`: All Cadence transaction templates updated to import `JanusFT` instead of `JanusMockFT`. Wrap/unwrap templates now accept the underlying FT contract name + address as parameters (forward-compatible for non-MockFT underlyings). `shieldedTransfer` template updated to match JanusFT's 9-parameter signature.
- `src/scan/cadence-scanner.ts`: doc comment updated.
- `tests/unit/cadence-scanner.test.ts`: all `JanusMockFT` → `JanusFT` event type strings updated.
- New Cadence transactions (in cadence-crypto-lab):
  - `wrap_ft.cdc`, `shielded_transfer_ft.cdc`, `unwrap_ft.cdc`, `setup_janus_ft_registry.cdc`, `publish_memokey_ft.cdc`

## 0.6.3 — 2026-06-02

**MemoKeyRegistry unification — single publishMemoKey covers all Janus tokens.**

### Architecture change (Track B++)

- New `MemoKeyRegistry` immutable EVM contract (`0x05D104962ff087441f26BA11A1E1C3b9E091D663`). All Janus EVM token proxies read BabyJub pubkeys from here instead of per-token mappings.
- All 3 EVM proxies (JanusFlow, JanusWFLOW, JanusMockUSDC) upgraded to canonical implementations (`JanusFlow` / `JanusERC20` contract names — no version suffix). `memoRegistry` wired to the shared registry at slot 90.
- Deprecated `memoKeyPubX`/`memoKeyPubY` per-token mappings kept at slots 7-8 for UUPS storage safety (marked as dead state).

### SDK changes

- `MEMO_REGISTRY_ADDRESS` exported from `network/contracts.ts` and `network/index.ts`.
- `JanusFlowAdapter.publishMemoKey()` now routes to `MemoKeyRegistry` directly (one tx = registered on all EVM tokens).
- `JanusERC20Adapter.publishMemoKey()` same.
- `getMemoKey()` in both EVM adapters reads from `MemoKeyRegistry.getMemoKey()` instead of per-token mapping getters.
- `rotateMemoKey()` added to both EVM adapters (+ optional interface method on `JanusTokenAdapter`).
- `memoRegistryAddress` property exposed on both EVM adapter classes.
- New Cadence transaction: `transactions/publish_memokey_xvm.cdc` — single Cadence tx that publishes to BOTH Cadence storage (`/storage/openjanusMemoKey`) AND the EVM registry via COA cross-VM call.

### Repo cleanup

- Deleted versioned contract files: `JanusToken_v0_6.sol`, `JanusToken_v0_6_3.sol`, `JanusFlow_v0_6.sol`, `JanusFlow_v0_6_3.sol`, `JanusERC20_v0_6.sol`, `JanusERC20_v0_6_3.sol`.
- Canonical contract files: `JanusToken.sol`, `JanusFlow.sol`, `JanusERC20.sol`.
- Deleted legacy Cadence spike: `JanusFT.cdc` + dead transactions (`wrap_ft.cdc`, `unwrap_ft.cdc`, `shielded_transfer_ft.cdc`, `setup_janus_ft_registry.cdc`).
- Removed `JanusFT` from `flow.json` and `flow.spike.json`.
- Cleaned `v0.6` version labels from `JanusMockFT.cdc` comments.

## 0.6.2 — 2026-06-02

Doc-only: README header now correctly reads v0.6.2 (0.6.0 / 0.6.1 had a stale header that said v0.6.0).

## 0.6.1 — 2026-06-02

Cleanup release. No public API changes from 0.6.0.

- Deleted `src/tokens/` (old v0.5 classes) entirely — `src/adapters/` is the only token home now.
- Deleted `src/recovery/` (superseded by `src/scan/latest-snapshot.ts`).
- Deleted unused `circuits/v0.5/` and `circuits/v0.5.1/` zkey artifacts (~16 MB).
- Bundle: 11.4 MB → 3.3 MB packed, 110 → 73 files.
- Added `src/scan/cadence-scanner.ts` — Flow REST event scanner for JanusMockFT (wrap, shieldedTransfer, unwrap events).
- `JanusFTAdapter.scanDeposits` + `latestSnapshot` now actually scan + decrypt live Cadence events (no stubs).
- `JanusFTAdapter.getMemoKey` reads from the shared `JanusFlow.MemoKey` resource at 0x5dcbeb41055ec57e (canonical `/public/openjanusMemoKey` — same key visible from all Janus Cadence apps).
- Fee math helpers moved to `src/crypto/fee-math.ts`.
- Switched circuit artifacts to v0.3 (matches deployed verifier addresses).
- TypeScript-clean. 150/150 unit pass. 42/42 live integration PASS. 5/5 Track F E2E gate PASS.

## 0.6.0 — 2026-06-01

**First production-ready release. Supersedes all prior versions.**

v0.5.x was testnet scaffolding. v0.6 is the release shipping with PrivateTip mainnet launch (~2026-06-15).

### Architecture rewrite

- **4-layer model**: adapters / orchestration / crypto+proof / network. See `docs/ARCHITECTURE.md`.
- **Generic adapters**: `JanusFlowAdapter` (native), `JanusERC20Adapter` (ERC20), `JanusFTAdapter` (Cadence FT) — parameterized via TOKEN_REGISTRY.
- **Single entry point**: `sdk.token('flow' | 'wflow' | 'mockusdc' | 'mockft')` returns a `JanusTokenAdapter`. Frontend stays dumb.
- **All orchestration in SDK**: `orchestration/wrap.ts`, `orchestration/shielded-transfer.ts`, `orchestration/unwrap.ts` own gross→net→proof→encrypt→params.
- **TOKEN_REGISTRY**: `network/contracts.ts` — single address source of truth.

### New tokens

- `wflow` — JanusWFLOW (ERC20, proxy `0x00129E94d5340bd19d0b4ed9CDf718BB6e0A9400`)
- `mockusdc` — JanusMockUSDC (ERC20, proxy `0xd45FDa099Cf67eD842eA379865AB08E18D62BAf3`)
- `mockft` — JanusMockFT (Cadence FT, `0x7599043aea001283`)

### New v0.6 EVM ABI surface

```solidity
// shieldedTransfer now has 9 params (was 6 in v0.5):
function shieldedTransfer(
  address to,
  uint256[6] publicInputs, uint256[8] proof,
  bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY,
  bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY
) external;
```

### Breaking changes from v0.5 (for PrivateTip Track D)

| Old (v0.5) | New (v0.6) |
|---|---|
| 6-param `shieldedTransfer` calldata builder | 9-param — `encryptedNoteTo + ephPubkeyToX/Y` added |
| `memoKeys` unified struct | `memoKeyPubX(addr)` + `memoKeyPubY(addr)` separate |
| `encryptMemo` helper | `encryptNote({amount, blinding, memo}, pubkey)` |
| Snapshot timestamps in seconds | `SNAPSHOT_TIMESTAMP_UNIT = 'ms'` always milliseconds |
| `new JanusFlow().wrap(params)` direct | `sdk.token('flow').wrap({grossAmount}, signer)` orchestrated |
| Proof built by app code | Proof built internally by orchestration |
| `buildAmountDiscloseProof` exposed to app | Internal to SDK; still exported for advanced use |

### Crypto schemas

- `crypto/snapshot-schema.ts`: `encryptSnapshot` / `decryptSnapshot`, wire format v=2
- `crypto/note-schema.ts`: `encryptNote` / `decryptNote`, wire format v=1 with `{amt, bld, memo, tip}` fields
- `crypto/memokey.ts`: `deriveMemoKeyFromSignature` — canonical MemoKey from wallet signature

### Tests

- 260 unit tests, all green
- Integration tests: token-adapter-contract, cross-token-memokey, gross-net-ordering, forward-secrecy, scan-recovery
- E2E Track F gate: `tests/e2e/cross-token-tip.test.ts`

---

## [0.5.4] — 2026-05-30

### Changed

- `recovery.scanJanusFlowSnapshots`: scanner now reads `firstSnapshotBlock(user)`
  from the JanusFlow contract (new in impl v0.5.3) for an O(1) starting-block hint,
  instead of defaulting to the last 9000 blocks. If the mapping returns 0 the user
  has never interacted and the scanner returns `[]` immediately without fetching any
  logs. Pagination is now chunked (9000 blocks/chunk) from the hint block to latest.
  Explicit `fromBlock` override still bypasses the hint entirely.
- `JANUS_FLOW_EVM_IMPL_ADDRESS` bumped to v0.5.3 impl:
  `0xd6584cb2788D2eA5c3AB61fb72aa9fEaC27ae79D`
- `JANUS_FLOW_VERSION` bumped to `"0.5.3"`.

---

## [0.5.3] — 2026-05-30

### Fixed

- `recovery.scanJanusFlowSnapshots`: default `fromBlock` to `latestBlock - 9000`
  when not explicitly provided, to stay within Flow EVM testnet's 10,000-block
  `eth_getLogs` cap. Previously the scanner defaulted to block 0 and failed with
  `eth_getLogs over 10000 block range` on any chain that enforces this limit.
  Callers can still pass `fromBlock: 0` explicitly to scan from genesis on chains
  without the cap.

---

## [0.4.0] — 2026-05-27

### Added (additive — no breaking changes from v0.3)

- `JanusERC20` concrete ERC20-wrapping confidential token on Flow EVM testnet.
  - Proxy at `0xf2C04b1A32B815ac7Ffd87a4C312096592BBCa1e`, pinned to MockUSDC
    underlying at `0x3e8973dE565743Ef9748779bE377BBE050A13C22` (6 decimals).
  - Same shielded-transfer privacy as `JanusFlow`; wrap boundary uses
    `approve + transferFrom` instead of `msg.value`.
  - New exports: `JanusERC20`, `JANUS_ERC20_TESTNET`, `JANUS_ERC20_EVM_ADDRESS`,
    `JANUS_ERC20_EVM_IMPL_ADDRESS`, `JANUS_ERC20_MOCK_USDC_ADDRESS`,
    `JANUS_ERC20_VERSION`, `JANUS_ERC20_MAX_WRAP_RAW`, `JANUS_ERC20_EXTRA_ABI`,
    `ERC20_MINIMAL_ABI`.
- `JanusFTCadence` Cadence-side wrapper for any FungibleToken vault.
  - Canonical contract at `0xbef3c77681c15397` (`openjanus-flow`); smoke
    mirror at `0x3c601a443c81e6cd`.
  - Default underlying is testnet FlowToken.Vault; configurable via Admin.
  - **Stub crypto in v0.4** — `babyAddStub` / `babyNegateStub` are
    placeholders; opaque proof acceptance. Structural privacy is real
    (calldata, events, storage). Cross-VM crypto + verification land in v0.5.
- Cadence transaction templates: `TX_FT_SETUP_REGISTRY`, `TX_FT_WRAP`,
  `TX_FT_SHIELDED_TRANSFER`, `TX_FT_UNWRAP`.
- Cadence read scripts: `SCRIPT_FT_GET_TOTAL_LOCKED`,
  `SCRIPT_FT_GET_COMMITMENT`, `SCRIPT_FT_GET_UNDERLYING_TYPE`.
- `buildJanusFTTx(template, addr)` helper to re-target a canonical template to
  a non-canonical deployment (mainnet, smoke mirror, etc.).
- 32 new unit tests covering JanusERC20 + JanusFT exports + templates.

### Reused (unchanged from v0.3)

- BabyJub.sol, AmountDiscloseVerifier, ConfidentialTransferVerifier — same
  primitives back both `JanusFlow` and `JanusERC20`.
- Same `circuits/v0.3/` zkey + wasm artifacts.

### Backwards compatibility

No breaking changes — existing JanusFlow imports keep working identically.

---

## [0.2.0-router] — 2026-05-26

### Added

- JanusFlow Cadence wrapper redeployed with router/impl pattern at new
  canonical account `0xbef3c77681c15397` (openjanus secondary account)
- Admin API on `JanusFlow` class:
  - `pause()` / `unpause()` — emergency stop; `isPaused()` is a public view
  - `finalizeImplSwap(authz)` / `cancelImplSwap(authz)` — 48h time-lock upgrade flow
  - `getActiveImplVersion()` — returns the current impl version string
- New Cadence transaction templates exported from `@openjanus/sdk/tokens`:
  - `TX_ADMIN_PAUSE`, `TX_ADMIN_UNPAUSE`
  - `TX_ADMIN_PROPOSE_IMPL_SWAP`, `TX_ADMIN_FINALIZE_IMPL_SWAP`, `TX_ADMIN_CANCEL_IMPL_SWAP`
  - `SCRIPT_IS_PAUSED`, `SCRIPT_GET_ACTIVE_IMPL_VERSION`
- `JANUS_FLOW_CADENCE_ADDRESS_LEGACY` constant (marked `@deprecated`) for the zombie address
- `JANUS_TOKEN_EVM`, `ENCRYPT_VERIFIER_EVM`, `DECRYPT_VERIFIER_EVM` re-exported as
  top-level constants from `@openjanus/sdk/tokens` for convenience
- Router e2e: 25/25 scenarios pass on `0xbef3c77681c15397` (2026-05-26)
- Deployment record: `circuits/setup/deployments-router.json`
- Architecture documentation: `docs/ARCHITECTURE.md` router section

### Changed

- `JANUS_FLOW_CADENCE_ADDRESS`: `0x28fef3d1d6a12800` → `0xbef3c77681c15397`
- `JANUS_FLOW_VERSION`: `"0.2.0"` → `"0.2.0-router"`
- `JanusFlow` class JSDoc: removed "deferred / not functional" warning — router is live
- All Cadence transaction templates updated to import from new canonical address
- Future impl upgrades happen via capability swap — apps unchanged, custody stays in router

### Deprecated

- `0x28fef3d1d6a12800.JanusFlow` — legacy v1 Pedersen, zombie (Flow restriction on removal)
  Exported as `JANUS_FLOW_CADENCE_ADDRESS_LEGACY`. Do not import. Use new canonical address.

---

## [0.2.0] — 2026-05-26

### Added

- `buildEncryptProof()` and `buildDecryptProof()` — Groth16 proof builders for ElGamal stack
  - `buildEncryptProof({ value, randomness, recipientPubkey })` → ciphertext + uint256[8] proof + public inputs
  - `buildDecryptProof({ ciphertext, secretKey, pubkey, amount })` → uint256[8] proof + public inputs
  - EIP-197 pi_b Fp2 swap applied automatically (EVM-ready output)
  - Reference pattern: `@zk-kit/groth16`
- Bundled circuit artifacts in `circuits/` (included in npm package):
  - `circuits/build/encrypt_consistency.wasm` + `circuits/build/decrypt_open.wasm`
  - `circuits/setup/encrypt_consistency_final.zkey` + `circuits/setup/decrypt_open_final.zkey`
  - `circuits/setup/encrypt_consistency_vkey.json` + `circuits/setup/decrypt_open_vkey.json`
  - `circuits/source/encrypt_consistency.circom` + `circuits/source/decrypt_open.circom`
- Trusted setup ceremony artifacts:
  - Phase 1: Hermez ceremony (200+ contributors, pot14 multi-party)
  - Beacon: Flow testnet block 323555648 (hash: 30f1f68e...)
  - SHA256 encrypt zkey: `17ab9353f2966336bbf380549a47721ccce4283f20000380e18ecab763c3da16`
  - SHA256 decrypt zkey: `d87eda3b96f2eeab11f33583369519d041d25915cdbd49cedf41fd269b8e0745`
- `circuits/setup/deployments-v0.2.0.json` — canonical deployment record

### Changed (BREAKING — new addresses)

- `JANUS_TOKEN_TESTNET` redeployed with ceremony-backed verifiers:
  - EVM: `0xb12E600fFcde967210cFD81CF9f32bBB6e68a499`
- `ENCRYPT_CONSISTENCY_VERIFIER`: `0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e`
- `DECRYPT_OPEN_VERIFIER`: `0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc`
- `JANUS_FLOW_VERSION` bumped to `"0.2.0"`
- `JANUS_FLOW_EVM_ADDRESS` updated to new JanusToken address
- Package `files` field now includes `circuits/` folder
- Package size: ~154KB → ~7.5MB (circuit artifacts bundled)
- e2e validation: 27/27 tests pass on new addresses (Phase B, 2026-05-26)

### Known Limitations

- `JanusFlow` Cadence wrapper at `0x28fef3d1d6a12800.JanusFlow` is legacy v1 code
  (Pedersen-based commitments). Flow protocol prevents contract removal without
  FlowServiceAccount authorization. **Use `JanusToken` class via user's COA for
  EVM-direct flows.** Cadence wrapper redeploy planned for v0.3.0.

### Deprecated

- Old `JanusToken` EVM: `0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D` (single-contributor zkey)
- Old `EncryptConsistencyVerifier`: `0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C`
- Old `DecryptOpenVerifier`: `0x3bB139B5404fD6b152813bC3532367AAa096638b`

---

## [0.1.0] — 2026-05-25

### Added

- `src/tokens/janus-token.ts` — `JanusToken` EVM SDK class (ElGamal accumulator):
  - `connect()` / `connectWithSigner()` — read-only and signing modes
  - `registerPubkey(pk)` — one-time BabyJubJub key registration
  - `getBalanceCiphertext(account)` / `getBalanceSlot(account)` — read encrypted slot
  - `hasPubkey(account)` / `pubkeyOf(account)` — pubkey registry queries
  - `encryptTo(recipient, proofResult, value)` — wrap FLOW + encrypt to recipient
  - `confidentialTransfer(recipient, proofResult)` — slot-to-slot transfer
  - `decryptAndUnwrap(to, amount, proofResult)` — prove decryption + release FLOW
  - Canonical testnet addresses exported as `JANUS_TOKEN_TESTNET`

- `src/tokens/janus-flow.ts` — `JanusFlow` Cadence cross-VM SDK class:
  - `configure()` -- configure FCL for network
  - `registerPubkey(pk, authz)` -- one-time pubkey registration
  - `wrapAndEncrypt(amount, recipient, proofResult, authz)` -- wrap FLOW + encrypt
  - `confidentialTransfer(recipient, proofResult, authz)` -- Cadence confidential transfer
  - `decryptAndUnwrap(amount, to, proofResult, authz)` -- release FLOW after decryption
  - `getSlot(userAddress)` / `getPubkey(userAddress)` -- read-only queries
  - Cadence transaction templates exported for custom integrations

- `src/crypto/` -- `computeCommitment`, `addCommitments`, `buildTransferProof`, `generateBlinding`
- `src/primitives/` -- BabyJub, Pedersen, Groth16 low-level wrappers
- `src/network/` -- `createEvmWallet`, `createEvmProvider`, `configureFCL`
- `src/utils/` -- hex utilities, pi_b swap (EIP-197 BN254 proof format)

- Deployed contracts (Flow EVM testnet):
  - `JanusToken.sol`: `0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D`
  - `JanusFlow.cdc`: `0x28fef3d1d6a12800` (contract: `JanusFlow`)
  - `BabyJub.sol`: `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870`
  - `EncryptConsistencyVerifier`: `0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C`
  - `DecryptOpenVerifier`: `0x3bB139B5404fD6b152813bC3532367AAa096638b`

- Privacy property confirmed (24/24 e2e tests PASS):
  - Bob receives 10 + 25 + 7 FLOW from Alice, Carol, Dave
  - Bob decrypts accumulated slot to 42 -- cannot recover individual amounts
  - All fraud cases rejected (wrong amount, wrong privkey, BSGS boundary, range overflow, premature rotation)
