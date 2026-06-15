# Test Coverage Audit — @claucondor/sdk v0.8.2

**Auditor:** automated static analysis, 2026-06-11  
**Scope:** `/home/oydual3/openjanus-sdk/src/` vs `tests/`  
**Methodology:** walk every exported symbol, grep for test coverage, cross-reference front-end usage patterns

---

## 1. Summary — Top 5 Risk Areas

1. **`memokey-vectors` test does not exist** — source code explicitly names this file as a required regression guard, but the file is absent. A silent change to the HKDF salt, context string, or output length would permanently brick all existing user checkpoints (fund loss), with no test to catch it.

2. **All three "prebuilt proof" orchestration paths are untested** — `orchestrateWrapWithPrebuiltProof`, `orchestrateUnwrapWithPrebuiltProofs`, and `orchestrateShieldedTransferWithPrebuiltProof` have zero test coverage. These are the *actual browser paths* the front-end uses (API routes POST here); the full-proof paths are Node-only and never reached from a browser context.

3. **`babyjub-utils.ts` — zero tests** — `parseFlowToWei`, `formatWeiToFlow`, `weiToFlowUFix64`, `assertWholeFlow` are the unit-conversion functions that format Cadence transaction arguments. Silent bugs here produce malformed UFix64 amounts or submit non-whole-FLOW wraps without failing loudly.

4. **`JanusFTAdapter` has no integration test** — the Cadence-FT adapter path (MockFT / mockft token) exercises different calldata, FCL flows, and token semantics than ERC20/native. The v0.8.2 per-token checkpoint changes were validated only for `flow` and `mockusdc`.

5. **`ShieldedCheckpointClient.encryptAndUpdate` is unit-untested** — the convenience method (`encryptSnapshot` + `update`) is what the front calls from the API route `/api/checkpoint/encrypt`. The snapshot-encrypt-then-write pipeline has no unit coverage verifying the combined output.

---

## 2. Untested Exports — API Surface vs Test Coverage

Table: `✓` = direct test exists, `~` = tested only indirectly (integration/helpers), `✗` = no test

### sdk entry point

| Export | Test coverage |
|--------|--------------|
| `sdk.token(id)` | `~` (used in e2e helpers only) |
| `sdk.tokens()` | `✗` |

### Adapters

| Export | Test coverage |
|--------|--------------|
| `JanusFlowAdapter` | `~` integration only (janus-flow.test.ts) |
| `JanusERC20Adapter` | `~` integration only (janus-erc20.test.ts) |
| `JanusFTAdapter` | `✗` **no integration test at all** |
| `JanusTokenAdapter` (type) | n/a |

### Orchestration

| Export | Test coverage |
|--------|--------------|
| `orchestrateWrap` | `~` called in integration, no unit |
| `orchestrateWrapWithPrebuiltProof` | `✗` |
| `orchestrateShieldedTransfer` | `~` called in integration, no unit |
| `orchestrateShieldedTransferWithPrebuiltProof` | `✗` |
| `orchestrateUnwrap` | `~` called in integration, no unit |
| `orchestrateUnwrapWithPrebuiltProofs` | `✗` |
| `randomNonce256` | `✗` |

### Crypto

| Export | Test coverage |
|--------|--------------|
| `deriveMemoKeyFromSignature` | `✗` (only the inner `deriveBabyJubKeypairFromBytes` is used in test helpers) |
| `deriveBabyJubKeypairFromBytes` | `~` helpers only, no regression vectors |
| `encryptSnapshot` | `✓` checkpoint-schema.test.ts |
| `decryptSnapshot` | `✓` checkpoint-schema.test.ts |
| `encryptNote` | `✓` note-helpers.test.ts |
| `decryptNote` | `✓` note-helpers.test.ts |
| `decryptAnyNote` | `✓` decrypt-any-note.test.ts |
| `generateBlinding` | `✗` |
| `generateBabyJubKeypair` | `~` used as setup in other tests, no direct test |
| `pubkeyFromPrivkey` | `✗` |
| `computeSharedSecret` | `~` only via encrypt/decrypt round-trips |
| `buildAmountDiscloseProof` | `~` integration path, no unit |
| `buildShieldedTransferProof` | `~` integration path, no unit |
| `computeNetWrap / computeWrapFee / computeNetUnwrap / computeUnwrapFee` | `✓` fee-math.test.ts |
| `MEMO_KEY_CONTEXT` | `✗` |

### Network / COA

| Export | Test coverage |
|--------|--------------|
| `TOKEN_REGISTRY` | `✓` contracts.test.ts |
| `KNOWN_COAS` / `getKnownCOA` | `✓` coa.test.ts |
| `getCOAAddressOnChain` | `✗` |
| `getCoaEvmAddress` | `✗` |
| `hasCOA` | `✗` |
| `getCoaBalanceWei` | `✗` |
| `getFlowVaultBalanceWei` | `✗` |
| `createEvmProvider` / `createEvmWallet` / `configureFCL` | `✗` |

### Checkpoint / Inbox

| Export | Test coverage |
|--------|--------------|
| `ShieldedCheckpointClient.exists` | `✓` |
| `ShieldedCheckpointClient.metadata` | `✓` |
| `ShieldedCheckpointClient.read` | `✓` |
| `ShieldedCheckpointClient.readAndDecrypt` | `✓` (null path only) — **no decrypt round-trip unit test** |
| `ShieldedCheckpointClient.update` | `✓` |
| `ShieldedCheckpointClient.encryptAndUpdate` | `✗` |
| `ShieldedInboxClient.count` | `✗` |
| `ShieldedInboxClient.peek` / `peekAll` | `✗` |
| `ShieldedInboxClient.drainAll` | `~` integration only |
| `ShieldedInboxClient.drainBatch` | `✗` |
| `ShieldedInboxClient.drainAndDecrypt` | `~` integration only |
| `ShieldedInboxClient.deposit` | `✗` |

### Cadence Templates

| Export | Test coverage |
|--------|--------------|
| `installInbox` | `✓` |
| `installCheckpoint` | `✓` |
| `installInboxAndCheckpoint` | `✓` |
| `updateCheckpointViaCoa` (transactions.ts) | `✓` |
| `combinedShieldedTransferWithCheckpoint` | `✓` (weak — EVMBytes count checks `≥1` not `=2`) |
| `wrapFlowAtomic` | `✓` |
| `sendTipAtomic` | `✓` |
| `unwrapFlowAtomic` | `✓` |
| `claimBatchAtomic` | `✓` |

### Utils / Primitives

| Export | Test coverage |
|--------|--------------|
| `applyPiBSwap` / `evmProofToUint256Array` | `✓` pi-b-swap.test.ts |
| `bigintReplacer` | `✗` |
| `bigintToHex` / `hexToBigint` / `padHex` / `decimalToBigint` | `✗` (entire hex.ts) |
| `isValidFlowAddress` / `isValidFlowAmount` / `formatPoint` | `✗` (entire format.ts) |
| `flowToWei` / `weiToFlow` / `parseFlowToWei` / `formatWeiToFlow` / `weiToFlowUFix64` / `assertWholeFlow` | `✗` (entire babyjub-utils.ts relevant exports) |
| `computeCommitment` | `~` via batch-claim tests |
| `addCommitmentsLocal` / `subCommitmentsLocal` | `~` via batch-claim tests |
| `buildBatchClaimProof` | `✓` batch-claim.test.ts (mocked snarkjs) |

**Rough coverage estimate:** ~45% of exported symbols have any direct test coverage. The uncovered 55% is skewed toward high-risk surface (orchestration, crypto derivation, utils used in calldata construction).

---

## 3. High-Risk Gaps — Categorized

### 3A. Cryptography Round-Trip

**decryptSnapshot backward-compat (v=2, v=3 wire format)**  
`checkpoint-schema.ts` explicitly accepts `v=2` and `v=3` payloads from the "legacy scan-era". No test exercises this path. If the JSON parsing for these formats is broken, users with old checkpoints that haven't been migrated cannot recover their state.

**`deriveMemoKeyFromSignature` — no regression vectors**  
`memokey.ts` (lines 1–40) contains an explicit, prominent warning: *"A failing test here means the derivation was changed — STOP and revert"* and names `tests/unit/memokey-vectors.test.ts` as the required file. That file does not exist. The warning covers 6 locked algorithm constants (HKDF salt, context, output length, hash, subgroup order, reduction). Any accidental change to any one would permanently brick all existing user checkpoints. This is the single most dangerous gap.

**`encryptSnapshot` + hex transport round-trip**  
The API route `/api/checkpoint/encrypt` calls `encryptSnapshot(...)`, then encodes the result as `Buffer.from(result.ciphertext).toString("hex")`. On the client the reverse is `Buffer.from(hex, "hex")`. No test verifies this specific encode→transport→decode cycle for the `Uint8Array`. A length-doubling bug, an off-by-one in hex encoding, or a missing `0x` prefix could silently produce a blob that is correctly-typed but unreadable by the on-chain contract (wrong byte count).

### 3B. Cadence Templates

**`combinedShieldedTransferWithCheckpoint` — EVMBytes count assertion is `≥1`, not `=2`**  
This template contains two separate `EVM.EVMBytes(value:)` wrappings: one for `encryptedNoteTo` (the recipient note), one for `encryptedSnapshot` (sender checkpoint). The existing test checks `count ≥ 1`. If the snapshot wrapping is accidentally removed (the original bug vector from v0.8.1), the test still passes. Should assert `=== 2`.

**`wrapFlowAtomic` — proxy address occurrence count is non-structural**  
The test checks that FLOW_PROXY appears `≥2` times (for janus call + checkpoint call). However the proxy also appears in an inline comment inside the template. The count assertion does not distinguish structural uses from cosmetic ones. A version where one structural call is dropped but the comment is retained would still pass.

**No template tests for EVM system contract address**  
All templates hard-code `EVM_SYSTEM_CONTRACT = "0x8c5303eaa26202d6"`. If this address ever changes (Flow testnet → mainnet migration), every template silently breaks. There is no test asserting the correct EVM system address is baked in each template.

### 3C. Cross-VM Encoding

**`orchestrateWrapWithPrebuiltProof` — zero tests**  
This is the function the front-end `/api/proof/wrap` result is processed through (browser cannot call `orchestrateWrap` which requires Node for wasm/zkey). The function: re-derives fee, computes netAmount, calls `encryptSnapshot`, and packages all calldata. Bugs here produce proof-commitment mismatches that appear as on-chain revert ("invalid amount_disclose proof"). Particularly risky: the `netAmount <= 0n` guard and the fee math.

**`orchestrateUnwrapWithPrebuiltProofs` — nonce=0 constraint untested**  
`orchestrateUnwrap` has a critical comment: "Nonce for unwrap is always 0n — JanusFlow._unwrap calls _verifyAmountDisclose(..., nonce=0). Passing any non-zero value causes on-chain revert." The prebuilt path accepts a caller-supplied `nonce` field. There is no test asserting that passing `nonce: 1n` changes the `amountPublicInputs[3]` field (i.e., that the nonce plumbing is connected and correct).

**`babyjub-utils` unit conversions — zero tests**  
`parseFlowToWei("1.5")` → `1500000000000000000n` is a non-trivial string parse with silent truncation behavior for >18 fractional digits. `weiToFlowUFix64` is called before every Cadence transaction argument to format the UFix64 amount string. Errors here silently produce the wrong amount in Cadence transactions. `assertWholeFlow` guards against dust amounts that would revert on-chain — untested means the guard itself might be wrong.

### 3D. Negative / Error Paths

**`orchestrateShieldedTransfer` with `transferAmount > currentBalance` — unit test missing**  
The guard exists in source (`throw RangeError`) but there is no unit test for it. Same for `orchestrateUnwrap` `claimedAmount > currentBalance`.

**`decryptNote` throws (vs `decryptSnapshot` returns null)**  
`decryptNote` throws on auth failure; `decryptSnapshot` returns `null`. This asymmetry is intentional but undocumented in tests. No test covers what happens in `drainAndDecrypt` when a note is encrypted to a different key (caught in the `failed[]` array). The error-path behavior of `drainAndDecrypt` is only covered by integration.

**`ShieldedCheckpointClient.read` — only `NoCheckpoint` error is mocked**  
The existing test mocks one negative path (NoCheckpoint). Other EVM errors ("out of gas", network timeout, wrong contract address) are not covered. Specifically: the `0x9e87fac8` 4-byte selector fallback in `_isNoCheckpointError` is untested.

**`randomNonce256` — BN254_R boundary rejection untested**  
The function uses rejection sampling: if a 32-byte random value `>= BN254_R`, it retries. No test exercises the boundary where a sample is forced equal to `BN254_R` (should reject) or just below (should accept). Probability of observing naturally is ~12% per call, but the sampling loop is not tested.

### 3E. Per-Token Coverage

**`JanusFTAdapter` — no test at any layer**  
The Cadence-FT path wraps/transfers via FCL, uses `cadenceAddress` as the token identifier for checkpoint calls, and has different calldata construction from ERC20. v0.8.2 added `address token` as first arg to `ShieldedCheckpoint.update()`. This was validated for flow/mockusdc only. No integration test exists for mockft.

**`ShieldedCheckpointClient.readAndDecrypt` — null path only in unit tests**  
The existing unit test only verifies the null path (no checkpoint). The SUCCESS path (decrypt returns `SnapshotContent`) is covered by integration only (`checkpoint-multi-token.integration.test.ts`). A unit test with a real BabyJub encrypt/decrypt (using `generateBabyJubKeypair`) would catch issues like the `ephPubkeyX`/`Y` extraction from `RawCheckpoint`.

---

## 4. Specific Test Cases to Add

### Priority 1 — Must Have (data loss / silent wrong calldata risk)

**TC-01** [unit] `src/crypto/memokey.ts` — `deriveMemoKeyFromSignature`  
Assert that a known 65-byte input + context `"openjanus/memokey/v1"` produces a known (locked) `privkey` bigint and `pubkey.x`/`pubkey.y`. Regression vector must be computed once from the current code and locked into the test. File: `tests/unit/crypto/memokey-vectors.test.ts`. Why: source explicitly names this file as a required safety net; fund loss if derivation drifts.

**TC-02** [unit] `src/crypto/memokey.ts` — stability across context strings  
Assert that `deriveBabyJubKeypairFromBytes(bytes, "openjanus/memokey/v1")` and `deriveBabyJubKeypairFromBytes(bytes, "openjanus/viewkey/v1")` produce *different* `privkey` values from the same input. Verifies domain separation is wired.

**TC-03** [unit] `src/orchestration/wrap.ts` — `orchestrateWrapWithPrebuiltProof`  
Assert: (a) fee math matches `computeNetWrap`; (b) `netAmount <= 0n` throws; (c) `encryptedSnapshot` is a non-empty `Uint8Array`; (d) `ephPubkeyX`/`Y` are bigints > 0. Mock `encryptSnapshot` to avoid BabyJub overhead. Why: browser path for every wrap — currently zero tests.

**TC-04** [unit] `src/orchestration/unwrap.ts` — `orchestrateUnwrapWithPrebuiltProofs`  
Assert: (a) nonce is passed through into `amountPublicInputs[3]`; (b) nonce=0n is the default; (c) `claimedAmount > currentBalance` throws; (d) `newBalance = currentBalance - claimedAmount`. Why: nonce=0 is a load-bearing constraint with an on-chain revert if violated.

**TC-05** [unit] `src/orchestration/shielded-transfer.ts` — `orchestrateShieldedTransferWithPrebuiltProof`  
Assert: (a) `encryptedNoteTo` is non-empty Uint8Array; (b) `checkpointPayload.encryptedSnapshot` is a separate, non-empty Uint8Array; (c) `newBalance = currentBalance - transferAmount`; (d) `transferAmount > currentBalance` throws. Why: this is what the front's `/api/proof/shielded-transfer` result flows through.

**TC-06** [unit] `src/crypto/babyjub-utils.ts` — `parseFlowToWei`  
Cover: `"1.5"` → `1500000000000000000n`; `"0.00000001"` → `10000000000n`; `"1"` → `1000000000000000000n`; >18 fractional digits truncated silently; whitespace trimmed. Why: produces Cadence UFix64 string arguments.

**TC-07** [unit] `src/crypto/babyjub-utils.ts` — `weiToFlowUFix64`  
Assert invariant: `parseFlowToWei(weiToFlowUFix64(x)) ≈ x` (within 8-decimal rounding). Also: `weiToFlowUFix64(1_500_000_000_000_000_000n)` === `"1.50000000"`. Why: directly fed into FCL Cadence args as UFix64.

**TC-08** [unit] `src/crypto/babyjub-utils.ts` — `assertWholeFlow`  
Assert: `assertWholeFlow(2n * 10n**18n)` does not throw; `assertWholeFlow(2n * 10n**18n + 1n)` throws with a message containing "dust". Why: guards against on-chain revert from non-whole amounts.

**TC-09** [unit] `src/checkpoint/ShieldedCheckpointClient.ts` — `readAndDecrypt` success path  
Use real `generateBabyJubKeypair` + `encryptSnapshot` to build a mock `RawCheckpoint`, inject it, then call `readAndDecrypt`. Assert `snap.balance` and `snap.blinding` match the original. Why: the per-token decrypt round-trip is the exact bug that was silent in v0.8.1 — this would have caught the singleton vs per-token issue at unit level.

**TC-10** [unit] `src/checkpoint/ShieldedCheckpointClient.ts` — `encryptAndUpdate`  
Mock `this.update(...)`. Assert it is called with `token` as first arg and the payload produced by `encryptSnapshot`. Why: this is the method the front-end uses in the checkpoint/encrypt API route.

**TC-11** [unit] `src/crypto/checkpoint-schema.ts` — backward compat decrypt (v=2, v=3)  
Manually construct a wire-format JSON `{"v":2,"bal":"100","bld":"99"}`, encrypt it with `encryptText`, then call `decryptSnapshot`. Assert it returns `{ balance: 100n, blinding: 99n }`. Repeat for v=3. Why: backward compat is claimed in source and used for migrating old scan-era checkpoints; if broken, existing users lose state.

**TC-12** [unit] `src/cadence/transactions.ts` — `combinedShieldedTransferWithCheckpoint` EVMBytes count  
Change existing assertion from `≥ 1` to `=== 2`. Why: there are two `EVM.EVMBytes(value:)` wrappings in this template (note + snapshot); the original v0.8.1 bug would have had count=0; the weak assertion would still pass if one wrapping is dropped.

### Priority 2 — High Value (subtle bugs likely)

**TC-13** [unit] `src/orchestration/wrap.ts` — `orchestrateWrap` netAmount is positive guard  
Assert that `orchestrateWrap({ grossAmount: 100n, feeBps: 10000 })` throws with a message about netAmount. (10000 bps = 100% fee → netAmount = 0.) Targets the `netAmount <= 0n` guard.

**TC-14** [unit] `src/orchestration/wrap.ts` — `randomNonce256` BN254_R boundary  
Use `vi.spyOn(randomBytes, ...)` to inject a forced value equal to `BN254_R` (should retry) and then `BN254_R - 1n` (should return). Assert that values >= BN254_R are never returned.

**TC-15** [unit] `src/inbox/ShieldedInboxClient.ts` — `drainAndDecrypt` partitioning  
Mock `drainAll` to return 3 notes: 2 encrypted to `keypairA`, 1 encrypted to `keypairB`. Call `drainAndDecrypt(signerA, keypairA.privkey)`. Assert `decrypted.length === 2`, `failed.length === 1`. Why: the correct/failed partitioning is load-bearing for state recovery.

**TC-16** [unit] `src/inbox/ShieldedInboxClient.ts` — empty inbox short-circuit  
Mock `drainAll.staticCall` to return `[]`. Assert that the live `drainAll()` call is NOT made (saved tx fee), and the returned `txHash` is `""`. Target: `drainAll` and `drainBatch` both have this optimization; it's untested.

**TC-17** [unit] `src/utils/hex.ts` — all 4 functions  
Cover: `bigintToHex(255n, 1)` === `"0xff"`; `bigintToHex(0n)` pads to 32 bytes; `hexToBigint("0xff")` === `255n`; `hexToBigint("")` === `0n`; `padHex("ab", 2)` === `"0x00ab"`; negative input throws.

**TC-18** [unit] `src/utils/format.ts` — `bigintReplacer`  
Assert `JSON.stringify({ a: 1n, b: "x" }, bigintReplacer)` === `'{"a":"1","b":"x"}'`. Why: front-end uses this when POST-ing proof results to API routes; if bigints aren't serialized as strings, the server receives NaN.

**TC-19** [unit] `src/utils/format.ts` — `isValidFlowAddress` and `isValidFlowAmount`  
Cover valid/invalid cases: `isValidFlowAddress("0x4b6bc58bc8bf5dcc")` → true; `isValidFlowAddress("0xabc")` → false; `isValidFlowAmount("1.0")` → true; `isValidFlowAmount("0")` → false (must be positive); `isValidFlowAmount("1.23456789012345678901")` → false (>18 decimals).

**TC-20** [unit] `src/orchestration/shielded-transfer.ts` — `checkpointPayload` and `txParams` use separate ephemeral keys  
Call `orchestrateShieldedTransferWithPrebuiltProof` with mocked inputs. Assert `txParams.ephPubkeyToX !== checkpointPayload.ephPubkeyX` (they must be from different ephemeral keypairs). Why: if snapshot and note accidentally share the same ephemeral, cross-decryption becomes possible.

**TC-21** [integration] `JanusFTAdapter` — wrap + shielded-transfer lifecycle (MockFT)  
Mirrors `janus-flow.test.ts` but for the Cadence-FT path. At minimum: `adapter.getMemoKey(addr)`, `adapter.publishMemoKey(kp, signer)`, `adapter.wrap(...)`, and verify on-chain commitment. Gated by `RUN_INTEGRATION=1`. Why: the only adapter path with zero coverage at any layer.

**TC-22** [unit] `src/cadence/atomic-transactions.ts` — `wrapFlowAtomic` structural proxy occurrence  
Change the `≥2` occurrences check to specifically verify that FLOW_PROXY appears within `EVM.addressFromString("...")` (not just as a substring anywhere). A regex like `EVM.addressFromString\("${addr}"\)` matched twice. Why: structural use (actual call target) vs cosmetic (comment) should be distinguished.

### Priority 3 — Lower Risk (regressions and completeness)

**TC-23** [unit] `src/crypto/commitment.ts` — `generateBlinding` output range  
Assert: result is a bigint in `[1, SUBORDER)`. Run 10 iterations to catch edge cases near zero. Why: zero blinding is a circuit constraint violation; tests in other files assume `generateBlinding()` never returns 0.

**TC-24** [unit] `src/network/coa.ts` — `getCOAAddressOnChain` error path  
Mock `fcl.query` to return empty string (no COA). Assert `getCOAAddressOnChain` returns null. Then return a valid hex string, assert it is correctly normalized. Why: callers treat null as "no COA" and skip cross-VM setup; incorrect null handling breaks the activation flow.

**TC-25** [unit] `src/cadence/transactions.ts` — `installInbox` idempotency structure  
Assert the template contains the `Type<@ShieldedInbox.NoteInbox>()` type check. If that guard is removed, calling installInbox twice would panic on-chain (duplicate storage path). Only structural assertion needed.

**TC-26** [unit] `src/cadence/transactions.ts` — `updateCheckpointViaCoa` vs `atomic-transactions.ts` — `updateCheckpointViaCoa`  
There are TWO functions named `updateCheckpointViaCoa` — one in `transactions.ts` and one in `atomic-transactions.ts`. Both generate a template. The cadenceTx namespace exposes one of them. Assert that `cadenceTx.updateCheckpointViaCoa()` produces the same template as `transactions.ts::updateCheckpointViaCoa()` (not the atomic version). Verify the atomic version is NOT accessible via `cadenceTx.updateCheckpointViaCoa`.

**TC-27** [unit] `src/crypto/babyjub-keypair.ts` — `pubkeyFromPrivkey` round-trip  
Assert that `pubkeyFromPrivkey(kp.privkey)` returns the same pubkey as the one in `generateBabyJubKeypair()`. Verify both `x` and `y` match. Why: if pubkey derivation drifts, all ECDH operations silently produce the wrong shared secret.

**TC-28** [unit] `src/utils/format.ts` — `isValidFlowAmount` edge: "0.00000001"  
Specifically assert `isValidFlowAmount("0.00000001")` is `true`. This is 1 attoFLOW-equivalent in UFix64 notation. The regexp `> 0` check via `parseFloat` can produce false negatives for very small floats near machine epsilon.

---

## 5. Lower-Priority Gaps (nice-to-have, not blockers)

- **`computeSharedSecret` direct unit test** — verify ECDH symmetry: `computeSharedSecret(a, B) === computeSharedSecret(b, A)` where A=a·G, B=b·G. Currently only tested transitively via encrypt/decrypt.

- **`BatchClaimClient.buildAndClaim` end-to-end** — existing tests cover `claimBatch` ABI wiring but not the higher-level `buildAndClaim` convenience method that chains proof generation + claim.

- **`sdk.token(id)` singleton caching** — assert that two calls to `sdk.token("flow")` return the same adapter instance (reference equality). Prevents unexpected state duplication from callers who construct adapters inside loops.

- **`createEvmProvider` / `createEvmWallet`** — mock-test that these produce an ethers provider/wallet with the correct chain ID (545 for testnet). Front-end uses `createEvmWallet` for every EVM-direct operation.

- **`LEGACY_V071_JANUSFLOW_PROXY` exclusion from TOKEN_REGISTRY** — assert the legacy proxy address does NOT appear in TOKEN_REGISTRY values. Guards against accidental re-inclusion during registry refactors.

- **E2E: multi-token checkpoint decrypt** — the existing `multi-token.test.ts` (RUN_E2E=1) exercises wraps/transfers but does not verify that the sender can RECOVER their post-transfer balance by calling `readAndDecrypt`. Add a Phase 4 step to each e2e lifecycle that reads the sender's checkpoint and asserts balance = expected net.

---

*Report generated: 2026-06-11. Total: 28 specific test cases, 5 suspected-broken findings.*
