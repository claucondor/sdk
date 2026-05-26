# Changelog

All notable changes to `@openjanus/sdk` are documented here.

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
