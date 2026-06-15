# Honest Audit — @claucondor/sdk v0.8.1-alpha.7
**Branch**: feat/v0.8-fresh  
**Audited**: 2026-06-11  
**Scope**: Atomic coverage, env config, changelog claims vs code, front gaps

---

## Audit A — Atomic Coverage Matrix

"Atomic" = single FCL/EVM transaction that includes both the shielded operation AND `ShieldedCheckpoint.update()`.

| Token | Operation | Atomic in SDK? | Tx count (actual) | Reference (file:line) |
|---|---|---|---|---|
| native FLOW | wrap | YES — wrapFlowAtomic exists + front uses it | 1 FCL tx | tip-actions.ts:753, atomic-transactions.ts:112 |
| native FLOW | sendTip | YES — sendTipAtomic exists + front uses it | 1 FCL tx | tip-actions.ts:927, atomic-transactions.ts:197 |
| native FLOW | unwrap | YES — unwrapFlowAtomic exists + front uses it | 1 FCL tx | tip-actions.ts:1118, atomic-transactions.ts:270 |
| native FLOW | claimBatch | Template exists in SDK (claimBatchAtomic). Front does NOT implement claimBatch at all. | — (not wired) | atomic-transactions.ts:343; no call site in tip-actions.ts |
| ERC20 mUSDC | wrap | NO. wrapViaCoa (janus-erc20.ts) does approve+wrap in 1 FCL tx, but checkpoint is a separate 2nd FCL tx. No wrapERC20Atomic template exists. | 2 FCL txs | tip-actions.ts:779 comment, tip-actions.ts:784+797 |
| ERC20 mUSDC | sendTip | NO. shieldedTransferViaCoa (janus-erc20.ts) inline template has NO checkpoint. 2nd FCL tx follows. | 2 FCL txs | tip-actions.ts:952 comment, tip-actions.ts:956+978 |
| ERC20 mUSDC | unwrap | NO. unwrapViaCoa (janus-erc20.ts) inline template has NO checkpoint. 2nd FCL tx follows. | 2 FCL txs | tip-actions.ts:1143 comment, tip-actions.ts:1147+1177 |
| ERC20 mUSDC | claimBatch | Not in front. Template would require reuse of sendTipAtomic pattern with ERC20 proxy — not wired. | — (not wired) | — |
| cadence-ft MockFT | wrap | NO. wrapViaCoa (janus-ft.ts) is a Cadence tx to JanusFT registry, no checkpoint. 2nd FCL tx follows. | 2 FCL txs | tip-actions.ts:779 comment, tip-actions.ts:789+797 |
| cadence-ft MockFT | sendTip | NO. shieldedTransfer (janus-ft.ts) goes to JanusFT Cadence registry, not EVM proxy. No atomic template exists or could apply (sendTipAtomic targets EVM contracts only). 2nd FCL tx follows. | 2 FCL txs | tip-actions.ts:952 comment, tip-actions.ts:966+978 |
| cadence-ft MockFT | unwrap | NO. unwrapViaCoa (janus-ft.ts) Cadence path, no checkpoint. 2nd FCL tx follows. | 2 FCL txs | tip-actions.ts:1143 comment, tip-actions.ts:1154+1177 |
| cadence-ft MockFT | claimBatch | Not in front. | — | — |

**Summary of atomic coverage**: 3 operations × 1 token variant = 3 atomic paths. The other 9 combinations (3 ops × 2 non-native variants) are all 2-tx. claimBatch has 0 front coverage regardless of token.

**Additional finding**: `wrapFlowAtomic` is named for FLOW specifically and imports `FungibleToken` + `FlowToken` (janus-flow-specific). It CANNOT be reused for ERC20 or FT wraps. There is no `wrapERC20Atomic`. The adapter-level `wrapViaCoa`/`shieldedTransferViaCoa`/`unwrapViaCoa` methods on `JanusERC20Adapter` and `JanusFTAdapter` all contain INLINE Cadence templates (not from `atomic-transactions.ts`) and none include checkpoint update.

---

## Audit B — Env Config Coverage

### From `src/network/contracts.ts`

| Constant | Value | Env-overridable? |
|---|---|---|
| TOKEN_REGISTRY.flow.proxy | 0xA64340…Ad3 | YES — JANUS_FLOW_PROXY |
| TOKEN_REGISTRY.mockusdc.proxy | 0xFD8F82…87d | YES — JANUS_ERC20_PROXY |
| TOKEN_REGISTRY.mockusdc.underlying | 0xd49Ff9…524 | YES — JANUS_ERC20_UNDERLYING |
| TOKEN_REGISTRY.mockft.cadenceAddress | 0x4b6bc58bc8bf5dcc | YES — MOCKFT_CADENCE_ADDRESS |
| MEMO_REGISTRY_ADDRESS | 0x361bD4…6c | YES — MEMO_REGISTRY_ADDRESS |
| FLOW_EVM_RPC | https://testnet.evm.nodes.onflow.org | YES — FLOW_EVM_RPC |
| CADENCE_SHIELDED_CHECKPOINT_ADDRESS | 0xd1a02aa46d9151bb | YES — CADENCE_SHIELDED_CHECKPOINT_ADDRESS |
| SHIELDED_INBOX_ADDRESS | 0x0C787A…bfC6 | **NO** — hardcoded, no env fallback (contracts.ts:88) |
| SHIELDED_CHECKPOINT_ADDRESS | 0x88C9fD…E26 | **NO** — hardcoded, no env fallback (contracts.ts:96) |
| FLOW_CADENCE_ACCESS | https://rest-testnet.onflow.org | **NO** — hardcoded, no env fallback (contracts.ts:146) |
| CADENCE_DEPLOYER_ADDRESS | 0x4b6bc58bc8bf5dcc | **NO** — hardcoded (contracts.ts:151) |
| COA_DEPLOYER_EVM_ADDRESS | 0x000000…356a | **NO** — hardcoded (contracts.ts:160) |
| VERIFIERS.* (5 entries) | various | **NO** — all hardcoded (contracts.ts:73-82) |

### Hardcoded addresses OUTSIDE `network/contracts.ts`

1. **`src/adapters/janus-ft.ts:340`** — `EVM.addressFromString("0x361bD4d037838A3a9c5408AE465d36077800ee6c")` hardcoded inside the `buildPublishMemoKeyTx()` Cadence template string. The TypeScript adapter constructor correctly reads `MEMO_REGISTRY_ADDRESS` from `contracts.ts` for the *ethers read path* (line 451), but the **Cadence write path** for `publishMemoKey` (line 340) ignores the env-var-overridden value entirely. Setting `MEMO_REGISTRY_ADDRESS` env var will NOT affect FCL `publishMemoKey` calls for the FT adapter.

2. **`src/primitives/groth16.ts:44,50`** — `CONFIDENTIAL_TRANSFER_VERIFIER_ADDRESS` and `AMOUNT_DISCLOSE_VERIFIER_ADDRESS` duplicated as module constants, not sourced from `contracts.ts`/`VERIFIERS` (minor duplication risk on address rotation).

3. **`src/primitives/pedersen.ts:41`, `src/primitives/babyjub.ts:50`** — BabyJub/Pedersen contract addresses hardcoded as module constants, not from `contracts.ts`.

4. **`src/adapters/janus-flow.ts:276` and `janus-erc20.ts:285`** — inline Cadence template strings reference Flow system addresses (`0x8c5303eaa26202d6`, `0x9a0766d93b6608b7`, `0x7e60df042a9c0868`) hardcoded. These are stable Flow system contracts, but they are NOT sourced from any env-overridable constant — if testnet/mainnet system contract addresses differ, these break.

5. **`src/cadence/atomic-transactions.ts:29`** — `EVM_SYSTEM_CONTRACT = "0x8c5303eaa26202d6"` hardcoded module constant with a comment explicitly saying it is "stable — not configurable". Acceptable for testnet but not mainnet-swap-ready.

### Addresses in `atomic-transactions.ts` and `transactions.ts`

`atomic-transactions.ts` imports `SHIELDED_CHECKPOINT_ADDRESS` and `SHIELDED_INBOX_ADDRESS` from `network/contracts.ts` (lines 23-26). These are baked in at call time via JS template literals. This is correct — templates interpolate from SDK constants, not from hardcoded inline strings. However, since neither `SHIELDED_CHECKPOINT_ADDRESS` nor `SHIELDED_INBOX_ADDRESS` is env-overridable, the addresses in the generated Cadence strings also cannot be overridden at runtime.

---

## Audit C — Documented vs Actual

| Claim (source) | Actual behaviour |
|---|---|
| **CHANGELOG alpha.6**: "Atomic templates moved from PrivateTip frontend...cadenceTx.wrapFlowAtomic(tokenAddrHex) — wrap + checkpoint in one tx" | Templates exist in SDK. The name `wrapFlowAtomic` is FLOW-specific (imports FlowToken, FungibleToken). Front uses it ONLY for native FLOW. No equivalent for ERC20 or FT. The commit message's "per-token" framing implies broader coverage than exists. |
| **CHANGELOG alpha.6**: "cadenceTx.sendTipAtomic(tokenAddrHex) — shieldedTransfer + checkpoint in one tx" | Template comment says it supports "both JanusFlow and JanusERC20 from a single template." True for the template in isolation. But the front gates on `entry.variant === "native"` (tip-actions.ts:869) before using it — ERC20 never reaches the atomic path. |
| **CHANGELOG alpha.6**: "cadenceTx.claimBatchAtomic(tokenAddrHex) — drainAll + claimBatch + checkpoint in one tx" | Template exists (atomic-transactions.ts:343). Front has no claimBatch implementation at all. Zero call sites. |
| **README line 9**: "New cadence/ module with atomic transfer+checkpoint templates" | Accurate about existence; misleading about scope — implies multi-token coverage, actual front coverage is FLOW-only. |
| **README lines 39-53** (quickstart code example): `checkpoint.update(checkpointPayload!, 0n, wallet)` | Stale: alpha.6 changed `update()` to require `token` as first arg — `update(token, payload, cursor, signer)`. README shows 3-arg signature, breaking-change docs are in CHANGELOG only. |
| **CHANGELOG alpha.6 MockFT caveat**: "Cadence FT checkpoint fix is deferred to a future sprint" | This is honest. MockFT has NO atomic wrap/send/unwrap+checkpoint path and none is planned until a future sprint. But the surrounding announcement of "per-token" atomic coverage omits that MockFT is completely uncovered. |

---

## Audit D — Front Non-Atomic Markers

All three are in `/home/oydual3/zkapps/private-tip-v1/web/lib/tip-actions.ts`:

1. **Line 779**: `// ── Non-atomic path: ERC20 / cadence-ft — keep 2-tx flow ───────────────────`  
   Context: `wrapToken()` — ERC20/FT wrap + checkpoint are separate transactions. Applies to both `mUSDC` and `mockft`.

2. **Line 952**: `// ── Non-atomic path: ERC20 / cadence-ft ────────────────────────────────────`  
   Context: `sendTip()` — ERC20/FT shielded transfer + checkpoint are separate transactions.

3. **Line 1143**: `// ── Non-atomic path: ERC20 / cadence-ft ────────────────────────────────────`  
   Context: `unwrapToken()` — ERC20/FT unwrap + checkpoint are separate transactions.

No occurrences of the literal strings "2-tx flow" or "keep 2-tx" — the marker format is `Non-atomic path`.

---

## Other Issues Worth Flagging

1. **`unwrapToken` ERC20/FT residual blinding is freshly generated, not from proof output** (tip-actions.ts:1176): `const residualBlinding = generateBlinding()`. This does not use the `newBlinding` from the orchestration result (`unwrapResult` has no `newBlinding` field on the `UnwrapResult` interface). The checkpoint stores a fresh random blinding that does NOT correspond to the on-chain commitment's actual blinding factor. This is silently broken — the next checkpoint read will decrypt the stored value, but it will not match the actual commitment until the user performs another operation that re-establishes consistency.

2. **`sendTip` ERC20 path references `newBalance`/`newBlinding` from adapter result** (tip-actions.ts:976-977): `sendResult.newBalance ?? (currentBalance - amount)` and `sendResult.newBlinding ?? generateBlinding()`. The ERC20 `shieldedTransferViaCoa` result DOES return `newBalance` and `newBlinding` (janus-erc20.ts:458). The `??` fallback to `generateBlinding()` for blinding would be wrong if `newBlinding` were undefined — verify this path carefully.

3. **`FLOW_CADENCE_ACCESS` hardcoded to testnet** with no env override (contracts.ts:146). Any mainnet/staging deploy needs to override this but cannot without forking the SDK.

4. **`JanusFlowAdapter.wrapViaCoa` (janus-flow.ts:275-316)** still has its OWN inline Cadence template for wrap, separate from the SDK's `wrapFlowAtomic`. The adapter method does NOT use `cadenceTx.wrapFlowAtomic`. Instead the front bypasses the adapter entirely and calls `cadenceTx.wrapFlowAtomic` directly (tip-actions.ts:753). This means the adapter's `wrapViaCoa` is still a NON-atomic method (no checkpoint), even for FLOW. If any caller uses `adapter.wrapViaCoa()` directly (not via the `wrapToken()` front helper), they get no checkpoint update and no atomic guarantee.
