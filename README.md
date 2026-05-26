# @openjanus/sdk

Unified TypeScript SDK for OpenJanus privacy primitives on Flow.

Consolidates @openjanus/babyjub, @openjanus/pedersen, and @openjanus/groth16
into a single, extensible package. Provides the cryptographic foundation for
the ElGamal-on-BabyJub confidential token stack.

---

## Install

```bash
npm install @openjanus/sdk
```

Dependencies (installed automatically):
- `ethers` ^6 -- Flow EVM provider
- `@onflow/fcl` ^1.13 -- Cadence transactions
- `circomlibjs` ^0.1.7 -- BabyJubJub operations
- `snarkjs` ^0.7.6 -- Groth16 proof generation

---

## Quick start

```typescript
import { JanusToken, JANUS_TOKEN_TESTNET } from "@openjanus/sdk/tokens";

// Read-only: read an account's encrypted slot
const token = new JanusToken(JANUS_TOKEN_TESTNET);
await token.connect();

const ct = await token.getBalanceCiphertext("0xAliceAddress");
// Identity (c1=(0,1), c2=(0,1)) means zero/empty slot

const hasPk = await token.hasPubkey("0xAliceAddress");
```

```typescript
import { JanusFlow } from "@openjanus/sdk/tokens";

// Full flow: register -> wrap -> transfer -> decrypt & unwrap
const sdk = new JanusFlow({ network: "testnet" });
await sdk.configure();

// 1. Register pubkey once (BabyJubJub public key derived from account key)
await sdk.registerPubkey(aliceKeypair.pk, aliceAuthz);

// 2. Any sender encrypts amount to Alice's pubkey and wraps FLOW
const proofResult = await buildEncryptProof({ amount: 10n, recipientPubkey: alicePK });
await sdk.wrapAndEncrypt("10.0", ALICE_CADENCE_ADDR, proofResult, senderAuthz);

// 3. Alice decrypts accumulated total (42 = 10 + 25 + 7 from three senders)
const decryptResult = await buildDecryptProof({ ciphertext: aliceSlot, secretKey: aliceSK, amount: 42n });
await sdk.decryptAndUnwrap("42.0", ALICE_CADENCE_ADDR, decryptResult, aliceAuthz);
```

---

## Module structure

```
@openjanus/sdk
+-- tokens/      JanusToken (EVM, ElGamal), JanusFlow (Cadence)
+-- crypto/      computeCommitment, buildTransferProof, generateBlinding
+-- primitives/  BabyJub, Pedersen, Groth16 (low-level)
+-- network/     createEvmWallet, createEvmProvider, COA helpers
+-- utils/       hex conversion, pi_b swap
```

---

## Tests

```bash
# Unit tests (no network, ~5 seconds)
npm test

# Integration tests (requires Flow EVM testnet access)
npm run test:integration

# All tests
npm run test:all
```

---

## Deployed contracts (testnet)

### v0.2.0 — ceremony-backed (Hermez pot14 + Flow VRF beacon)

| Contract | Network | Address |
|----------|---------|---------|
| JanusToken.sol | Flow EVM testnet | `0xb12E600fFcde967210cFD81CF9f32bBB6e68a499` |
| JanusFlow.cdc | Flow Cadence testnet | `0x28fef3d1d6a12800` (contract: `JanusFlow`, legacy v1 — deferred, see CHANGELOG) |
| BabyJub.sol | Flow EVM testnet | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` |
| EncryptConsistencyVerifier | Flow EVM testnet | `0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e` |
| DecryptOpenVerifier | Flow EVM testnet | `0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc` |

Trusted setup: Hermez phase 1 (200+ contributors) + Flow VRF beacon (testnet block 323555648).
SHA256 zkey hashes verifiable via `circuits/setup/` in package.

### Deprecated — v0.1.0 (single-contributor zkey, DO NOT USE)

| Contract | DEPRECATED Address |
|----------|--------------------|
| JanusToken.sol | `0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D` |
| EncryptConsistencyVerifier | `0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C` |
| DecryptOpenVerifier | `0x3bB139B5404fD6b152813bC3532367AAa096638b` |

---

## Extending the SDK

Adding a new module (e.g., HekateMixer) is purely additive. See [docs/EXTENDING.md](docs/EXTENDING.md).

---

## License

MIT -- oydual3 <claucondor@gmail.com>
