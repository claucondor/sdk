# @claucondor/sdk Architecture — v0.6.0

## The 4-layer model

```
┌─────────────────────────────────────────┐
│            ADAPTERS                      │  ← Public API: sdk.token(id)
│  JanusFlowAdapter / JanusERC20Adapter   │     Frontend calls only this layer.
│  JanusFTAdapter                          │
└────────────────┬────────────────────────┘
                 │ delegates to
┌────────────────▼────────────────────────┐
│          ORCHESTRATION                   │  ← ALL ordering logic lives here.
│  wrap.ts / shielded-transfer.ts         │     gross→net→proof→encrypt→params.
│  unwrap.ts                               │
└────────────────┬────────────────────────┘
                 │ calls
┌────────────────▼────────────────────────┐
│        CRYPTO + PROOF                    │  ← Pure crypto, no side effects.
│  snapshot-schema / note-schema          │
│  amount-disclose / shielded-transfer    │
│  memokey / ecdh / pi-b-swap             │
└────────────────┬────────────────────────┘
                 │ uses
┌────────────────▼────────────────────────┐
│           NETWORK                        │  ← Chain I/O only.
│  evm-client / flow-client               │
│  contracts.ts (TOKEN_REGISTRY)          │
│  scan/ (event-scanner, latest-snapshot) │
└─────────────────────────────────────────┘
```

## Timestamp convention

`SNAPSHOT_TIMESTAMP_UNIT = 'ms'` — all timestamps are milliseconds. This constant is the single authoritative source. The v0.5.6/5.7 bug was a unit mismatch (scanner used seconds, reconstructor used milliseconds).

## KEY RULE: Wrap proof binds to NET, not GROSS

```
grossAmount → contract (msg.value or transferFrom)
netAmount = grossAmount - fee   ← proof MUST bind to this
fee goes to feeRecipient
```

Passing grossAmount to `buildAmountDiscloseProof` causes a silent verification revert.

## KEY RULE: Unwrap proof binds to CLAIMED (full debit), not net

```
claimedAmount → proof (full debit from commitment)
netToRecipient = claimedAmount - fee   ← what recipient actually gets
```

## EVM ABI: selector trap

Use canonical `uint256[N]`, NOT `uint[N]`. Wrong selectors cause silent reverts.

## Cadence FT: pi_b swap

Apply `applyPiBSwap` before flattening proof to `[UInt256]`. Without this, `_verifyGroth16` silently returns false. The SDK applies this automatically in all orchestration paths.

## Module hierarchy (v0.3 era — preserved below)

```
src/
├── types/          Layer 0 — Pure TypeScript types (no runtime code)
├── utils/          Layer 1 — Pure utilities (no imports from other SDK modules)
├── primitives/     Layer 2 — Low-level crypto (BabyJub, Pedersen, Groth16)
├── network/        Layer 2 — Flow client + COA management (no crypto imports)
├── crypto/         Layer 3 — High-level crypto operations (imports primitives)
└── tokens/         Layer 4 — Token-level SDK (imports crypto + network)
```

Dependencies only flow downward. No module imports from a higher layer.

```
tokens    ──────────────────────────────────► crypto → primitives
                                                  └──────────────► types, utils
network   ──────────────────────────────────► types, utils
```

## Module responsibilities

### `types/` — Shared types

No runtime code. Only TypeScript type definitions and constants.

- `proof.ts` — Groth16 proof types (SnarkJSProof, EVMProof, ProofUint256, PublicInputsUint256)
- `commitment.ts` — Point, CommitmentXY, CURVE_P, IDENTITY_POINT, isIdentityPoint

### `utils/` — Pure utilities

Stateless helper functions. No domain logic.

- `hex.ts` — bigintToHex, hexToBigint, padHex, decimalToBigint
- `pi-b-swap.ts` — EIP-197 Fp2 coordinate swap (critical for Groth16 → EVM)

### `primitives/` — Low-level cryptography

Close to the math. Each file matches one deployed contract or cryptographic scheme.

- `babyjub.ts` — BabyJubJub curve: constants, local field ops, on-chain caller (BabyJub.sol)
- `pedersen.ts` — Pedersen commitments: computeCommitment, add, negate, FCL scripts
- `groth16.ts` — Groth16: prove, proveForEVM, verifyOnChain, verifyLocally

### `network/` — Flow connectivity

Manages RPC endpoints and Cadence account interactions.

- `flow-client.ts` — NETWORK_CONFIG, createEvmProvider, createEvmWallet, configureFCL
- `coa.ts` — KNOWN_COAS map, getCOAAddressOnChain

### `crypto/` — Application-level crypto

Composes primitives into workflows. This is what most application code uses.

- `commitment.ts` — computeCommitment, addCommitments, negateCommitment, generateBlinding, decryptBalance
- `transfer-proof.ts` — buildTransferProof: end-to-end proof generation for confidentialTransfer

### `tokens/` — Token SDKs

High-level SDK classes for deployed token contracts.

- `janus-token.ts` — JanusToken (EVM NATIVE mode): connect, balanceOfCommitment, mint, confidentialTransfer
- `janus-flow.ts` — JanusFlow (Cadence FLOW wrapper): wrap, confidentialTransfer, unwrap
- `types.ts` — Shared token types (TokenOptions, TokenDeployment, TransferProofInput/Result)

## Design principles

**1. Zero `any` in module boundaries**

Each module has typed inputs and outputs. The only `any` in the codebase is
for ethers.js Contract instances (because ethers uses `any` internally for
dynamic ABI dispatch) and FCL dynamic argument functions. These are marked
with `@ts-expect-error FCL types are dynamic`.

**2. Dynamic imports for heavy deps**

circomlibjs, snarkjs, ethers, and @onflow/fcl are all dynamically imported
inside functions. This keeps the top-level import cost near zero, and allows
tree-shaking in bundled environments. Example:

```typescript
const { buildBabyjub } = await import("circomlibjs");
```

**3. Instance caching for WASM**

circomlibjs WASM initialization takes ~500ms. The SDK caches instances in
module-level variables after the first call. This is safe in server environments
(single process, single WASM instance per runtime) and browser environments.

**4. Additive extensibility**

Adding a new module requires zero changes to existing modules. Only two files
change: `src/index.ts` (one export line) and `tsup.config.ts` (one entry point).
See `docs/EXTENDING.md` for the step-by-step guide.

**5. EIP-197 pi_b swap is always automatic**

Every code path that submits a proof to an EVM verifier applies the Fp2 swap
via `applyPiBSwap()`. Application code never needs to think about this.
The raw `SnarkJSProof` type is kept for local verification only.

## Router Pattern — JanusFlow v0.2.0+

JanusFlow Cadence wrapper uses a router/facade + swappable implementation pattern,
deployed at a new canonical account `0xbef3c77681c15397` (openjanus secondary account).

### Contracts at 0xbef3c77681c15397

| Contract | Role | Notes |
|----------|------|-------|
| `JanusFlow` | Router + custody | Public canonical contract — stable forever |
| `JanusFlowImpl` | Current impl | Pure stateless logic, swappable |
| `IJanusFlowImpl` | Impl interface | All future impls must conform |

### Architecture rationale

- `JanusFlow` (router): holds the FLOW vault, commitments map, and pubkeys map.
  Exposes the public API (registerPubkey, wrapAndEncrypt, confidentialTransfer,
  decryptAndUnwrap, getSlot, getPubkey) plus admin operations (pause, impl-swap).
  **This address is what apps import. It never changes.**

- `JanusFlowImpl` (current impl): pure logic — validates proofs, computes slot updates,
  returns results. No state. Receives data from the router, returns computed values.
  The router stores all state. The impl is disposable.

- `IJanusFlowImpl` (interface): the interface contract that all future implementations
  must conform to. Decouples the router from concrete impl details.

### Upgrade flow

1. Admin proposes new impl via `proposeImplSwap(newImplCapability)`.
   The 48h (172800s) time-lock starts. An on-chain event is emitted.
2. Apps observe the event and have 48h to review, test, or object.
3. After 48h, admin calls `finalizeImplSwap()`. The router swaps the impl capability.
   Apps are completely transparent to this — they import JanusFlow at the same address.
4. If the admin wants to abort before 48h, `cancelImplSwap()` resets the pending state.

### Custody guarantee

The FLOW vault, commitments, and pubkeys all live in the router contract forever.
**No funds move during an impl swap.** This is the key safety property:
users can always unwrap their FLOW even if the impl is swapped, because the vault
is in the router, not in the impl.

### Admin capability pattern

The `AdminResource` is stored at `/storage/janusFlowAdmin` on the contract account
(`0xbef3c77681c15397`). Only the holder of this resource can:
- pause / unpause the contract
- propose, finalize, or cancel impl swaps

For production, the AdminResource should be held by a multi-sig account.

### Emergency stop

`pause()` halts all write operations (wrapAndEncrypt, confidentialTransfer,
decryptAndUnwrap, registerPubkey). Read operations (getSlot, getPubkey, isPaused)
remain active. `unpause()` restores normal operation.

### SDK integration

```typescript
import { JanusFlow, JANUS_FLOW_CADENCE_ADDRESS } from "@claucondor/sdk/tokens";

const sdk = new JanusFlow({ network: "testnet" });
await sdk.configure();

// Check if paused before operations
const paused = await sdk.isPaused();

// Admin: pause
await sdk.pause(adminAuthz);

// Admin: unpause
await sdk.unpause(adminAuthz);

// Check current impl version
const version = await sdk.getActiveImplVersion(); // e.g. "0.1.0"

// Admin: finalize impl swap (after 48h from proposeImplSwap on-chain)
await sdk.finalizeImplSwap(adminAuthz);

// Admin: cancel pending impl swap proposal
await sdk.cancelImplSwap(adminAuthz);
```

### Why a new account (not an update to the old one)?

The legacy JanusFlow at `0x28fef3d1d6a12800` cannot be removed or replaced with
incompatible code without `FlowServiceAccount` authorization, which is not available
on testnet without special access. Deploying to a new account is the correct
production-grade approach — it also forces a clean address separation between the
legacy zombie and the new canonical contract.

## Deployed contracts (testnet)

### v0.2.0-router (canonical)

| Contract | Address | Notes |
|----------|---------|-------|
| JanusFlow.cdc (router) | `0xbef3c77681c15397` | Canonical — stable forever |
| JanusFlowImpl.cdc | `0xbef3c77681c15397` | Current impl |
| IJanusFlowImpl.cdc | `0xbef3c77681c15397` | Impl interface |
| JanusToken.sol | `0xb12E600fFcde967210cFD81CF9f32bBB6e68a499` | EVM accumulator |
| EncryptConsistencyVerifier | `0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e` | Groth16 verifier |
| DecryptOpenVerifier | `0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc` | Groth16 verifier |
| BabyJub.sol | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` | Used by JanusToken |

### Deprecated — zombie (DO NOT USE)

| Contract | Address | Notes |
|----------|---------|-------|
| JanusFlow.cdc (v1 Pedersen) | `0x28fef3d1d6a12800` | Zombie — cannot be removed |

## Test strategy

**Unit tests** (`tests/unit/`) — no network, fast (<5s total):
- Known test vectors for BabyJub curve operations
- Pedersen commitment math and homomorphic properties
- Groth16 pi_b swap correctness
- Hex/BigInt utilities

**Integration tests** (`tests/integration/`) — real testnet, gated by `RUN_INTEGRATION=1`:
- JanusToken read operations (balanceOfCommitment, isWrapperMode, totalSupply)
- BabyJub.sol on-chain point operations vs local reference values
- Groth16 proof generation + on-chain verification
- (Full E2E: wrap → transfer → unwrap — documented via reference TX hashes)
