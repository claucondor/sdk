# @openjanus/sdk Architecture

## Module hierarchy

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

## Deployed contracts (testnet)

| Contract | Address | Notes |
|----------|---------|-------|
| BabyJub.sol | 0x2c40513b343B70f2A0B7e6Ad6F997DDa819D6f07 | Stateless, reuse |
| ConfidentialTransferVerifier | 0x0085F286d89af79EC59E27CD0c5CcD1c55f42Cf5 | Groth16 verifier |
| JanusToken.sol (demo, NATIVE) | 0x53F49881A1132FF4F674D2c015e35D5B07Fa1F4A | ERC-7984 |
| JanusToken.cdc | 0x28fef3d1d6a12800 (JanusToken) | Cadence contract |
| JanusFlow.cdc | 0x28fef3d1d6a12800 (JanusFlow v1.1.0) | FLOW wrapper |
| PedersenBabyJub.cdc | 0x28fef3d1d6a12800 | Cadence Pedersen |

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
