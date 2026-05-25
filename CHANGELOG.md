# Changelog

All notable changes to `@openjanus/sdk` are documented here.

---

## [0.2.0] — 2026-05-25

### Removed (Breaking)

- **v1 token stack** (`src/tokens/` — `JanusToken`, `JanusFlow`, Pedersen-hash based) has been archived.
  - Reason: circomlib Pedersen is a multi-base hash function, not a 2-generator EC commitment.
    The accumulated commitment slot does not open to a "total" value in multi-sender scenarios.
    Additionally, the Cadence `vault.withdraw(amount: amount)` call emits a standard
    `TokensWithdrawn` event with plaintext amount, defeating amount privacy for JanusFlow users.
    This meant recipients (or chain indexers) could recover per-sender amounts — defeating the
    privacy property the system claimed.
  - Replacement: v2 stack using ElGamal-on-BabyJub provides true recipient-knows-total-only
    privacy. See [openjanus/contracts](https://github.com/openjanus/contracts) for v2 contracts.
  - Migration: see [docs/why-v1-was-deprecated.md](docs/why-v1-was-deprecated.md).
  - Historical access: `git checkout v0.1.0-final` or `npm install @openjanus/sdk@^0.1.0`.
  - v1 contracts remain deployed on Flow EVM testnet for historical reference;
    they should not be used for new development.
- Removed `./tokens` package export from `package.json`
- Removed `tokens/index` entry from `tsup.config.ts`
- Removed v1 integration tests (`tests/integration/janus-token.integration.test.ts`)
- Removed v1 examples (`examples/basic-transfer.ts`, `examples/multi-wrap.ts`)
  - Legacy examples preserved as non-runnable reference at `docs/legacy/EXAMPLES_V1.md`

### Added

- `docs/why-v1-was-deprecated.md` — public-friendly explanation of the v1 privacy limitation
  and migration guide
- `docs/legacy/EXAMPLES_V1.md` — archived v1 example code for historical reference

### Kept (no change)

- `src/primitives/` — BabyJub, Pedersen, Groth16 primitives (still valid, used by v2 verifiers)
- `src/crypto/` — commitment utilities, transfer proof generation
- `src/network/` — Flow client, COA helpers
- `src/utils/` — hex utilities, pi_b swap
- `src/types/` — shared TypeScript types
- All 72 unit tests pass

---

## [0.1.0] — 2026-05-24

Initial release with v1 (Pedersen-hash) token stack.

- `src/tokens/janus-token.ts` — `JanusToken` EVM SDK class (NATIVE + WRAPPER mode)
- `src/tokens/janus-flow.ts` — `JanusFlow` Cadence cross-VM SDK class
- `src/crypto/` — `computeCommitment`, `addCommitments`, `buildTransferProof`, `generateBlinding`
- `src/primitives/` — BabyJub, Pedersen, Groth16 low-level wrappers
- `src/network/` — `createEvmWallet`, `createEvmProvider`, `configureFCL`
- 72 unit tests (babyjub, pedersen, groth16, utils)
- Deployed contracts (Flow EVM testnet):
  - `JanusToken.sol`: `0x53F49881A1132FF4F674D2c015e35D5B07Fa1F4A`
  - `JanusFlow.cdc`: `0x28fef3d1d6a12800` (contract: `JanusFlow` v1.1.0)
  - `BabyJub.sol`: `0x2c40513b343B70f2A0B7e6Ad6F997DDa819D6f07`
  - `ConfidentialTransferVerifier`: `0x0085F286d89af79EC59E27CD0c5CcD1c55f42Cf5`
