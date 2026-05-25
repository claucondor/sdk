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

### Primitive contracts (canonical)

| Contract | Address |
|----------|---------|
| BabyJub.sol | `0x2c40513b343B70f2A0B7e6Ad6F997DDa819D6f07` |
| ConfidentialTransferVerifier | `0x0085F286d89af79EC59E27CD0c5CcD1c55f42Cf5` |

### JanusToken contracts (current)

| Contract | Address |
|----------|---------|
| JanusToken.sol | `0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D` |
| JanusFlow.cdc | `0x28fef3d1d6a12800` (contract: `JanusFlow`) |
| BabyJub.sol (lab) | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` |
| EncryptConsistencyVerifier | `0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C` |
| DecryptOpenVerifier | `0x3bB139B5404fD6b152813bC3532367AAa096638b` |

---

## Extending the SDK

Adding a new module (e.g., HekateMixer) is purely additive. See [docs/EXTENDING.md](docs/EXTENDING.md).

---

## License

MIT -- oydual3 <claucondor@gmail.com>
