# Changelog

All notable changes to `@openjanus/sdk` are documented here.

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
