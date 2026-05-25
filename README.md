# @openjanus/sdk

Unified TypeScript SDK for OpenJanus privacy primitives on Flow.

Consolidates @openjanus/babyjub, @openjanus/pedersen, and @openjanus/groth16
into a single, extensible package. Provides the cryptographic foundation for
the v2 ElGamal-on-BabyJub confidential token stack.

---

## Versioning

| Version | Status | Description |
|---------|--------|-------------|
| `^0.2.0` | **Current** | v2 token stack (ElGamal-on-BabyJub) + primitives. v1 token layer archived. |
| `^0.1.0` | **Legacy (deprecated)** | v1 stack: Pedersen-hash based JanusToken/JanusFlow. Has known privacy limitation. Do not use for new apps. |

### Why v1 was deprecated

v1 used circomlib's Pedersen hash for balance commitments. While cryptographically binding and
hiding, this hash is not additively homomorphic in the value domain, and the Cadence cross-VM
wrap layer leaked plaintext amounts via standard `TokensWithdrawn` events. In multi-sender
scenarios, recipients could recover per-sender amounts — defeating the privacy goal.

v2 replaces this with ElGamal-on-BabyJub encryption, which is additively homomorphic and does
not require per-sender amount knowledge to decrypt.

Full explanation: [docs/why-v1-was-deprecated.md](docs/why-v1-was-deprecated.md)

---

## Install

```bash
npm install @openjanus/sdk
```

Dependencies (installed automatically):
- `ethers` ^6 — Flow EVM provider
- `@onflow/fcl` ^1.13 — Cadence transactions
- `circomlibjs` ^0.1.7 — Pedersen hash (BabyJubJub)
- `snarkjs` ^0.7.6 — Groth16 proof generation

---

## Quick start — v2 (ElGamal, RECOMMENDED for new apps)

```typescript
import { JanusTokenV2, JANUS_TOKEN_V2_TESTNET } from "@openjanus/sdk/tokens-v2";

// Read-only: read an account's encrypted slot
const token = new JanusTokenV2(JANUS_TOKEN_V2_TESTNET);
await token.connect();

const ct = await token.getBalanceCiphertext("0xAliceAddress");
// Identity (c1=(0,1), c2=(0,1)) means zero/empty slot

const hasPk = await token.hasPubkey("0xAliceAddress");
```

```typescript
import { JanusFlowV2 } from "@openjanus/sdk/tokens-v2";

// Full flow: register → wrap → transfer → decrypt & unwrap
const sdk = new JanusFlowV2({ network: "testnet" });
await sdk.configure();

// 1. Register pubkey once (BabyJubJub public key derived from account key)
await sdk.registerPubkey(aliceKeypair.pk, aliceAuthz);

// 2. Any sender encrypts amount to Alice's pubkey and wraps FLOW
const proofResult = await buildEncryptProof({ amount: 10n, recipientPubkey: alicePK, ... });
await sdk.wrapAndEncrypt("10.0", ALICE_CADENCE_ADDR, proofResult, senderAuthz);

// 3. Alice decrypts accumulated total (42 = 10 + 25 + 7 from three senders)
const decryptResult = await buildDecryptProof({ ciphertext: aliceSlot, secretKey: aliceSK, amount: 42n, ... });
await sdk.decryptAndUnwrap("42.0", ALICE_CADENCE_ADDR, decryptResult, aliceAuthz);
```

---

## Quick start — primitives (low-level crypto)

### Compute a Pedersen commitment

```typescript
import { computeCommitment, generateBlinding } from "@openjanus/sdk";

// Generate a random blinding factor — STORE THIS
const blinding = generateBlinding();

// Commit to 10 FLOW
const commitment = await computeCommitment(10n, blinding);
console.log(commitment); // { x: <bigint>, y: <bigint> }
```

### Generate a ZK transfer proof

```typescript
import { buildTransferProof } from "@openjanus/sdk";

const proofResult = await buildTransferProof({
  oldBalance: 10n,
  oldBlinding: myStoredBlinding,
  transferAmount: 3n,
  transferBlinding: generateBlinding(),
  newBlinding: generateBlinding(),
  wasmPath: "/path/to/confidentialTransfer.wasm",
  zkeyPath: "/path/to/confidentialTransfer_final.zkey",
  vkPath: "/path/to/verification_key.json", // optional local verification
});

console.log(proofResult.locallyVerified); // true
// proofResult.proof and proofResult.publicInputs are ready for on-chain submission
```

---

## Module structure

```
@openjanus/sdk
├── tokens-v2/   JanusTokenV2 (EVM, v2 ElGamal), JanusFlowV2 (Cadence, v2)
├── crypto/      computeCommitment, buildTransferProof, generateBlinding
├── primitives/  BabyJub, Pedersen, Groth16 (low-level)
├── network/     createEvmWallet, createEvmProvider, COA helpers
└── utils/       hex conversion, pi_b swap
```

> The v1 `tokens/` module (JanusToken, JanusFlow, Pedersen-based) was archived in 0.2.0.
> Historical source: `git checkout v0.1.0-final`
> Migration: [docs/why-v1-was-deprecated.md](docs/why-v1-was-deprecated.md)

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

### Primitive contracts (canonical, used by v2)

| Contract | Address |
|----------|---------|
| BabyJub.sol | `0x2c40513b343B70f2A0B7e6Ad6F997DDa819D6f07` |
| ConfidentialTransferVerifier | `0x0085F286d89af79EC59E27CD0c5CcD1c55f42Cf5` |

### v2 token contracts (current — RECOMMENDED)

| Contract | Address |
|----------|---------|
| JanusTokenV2.sol | `0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D` |
| JanusFlowV2.cdc | `0x28fef3d1d6a12800` (contract: `JanusFlowV2`) |
| BabyJub.sol (v2/lab) | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` |
| EncryptConsistencyVerifier | `0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C` |
| DecryptOpenVerifier | `0x3bB139B5404fD6b152813bC3532367AAa096638b` |

### v1 contracts (historical — do not use for new development)

| Contract | Address | Status |
|----------|---------|--------|
| JanusToken.sol (NATIVE demo) | `0x53F49881A1132FF4F674D2c015e35D5B07Fa1F4A` | **DEPRECATED** |
| JanusFlow.cdc (v1.1.0) | `0x28fef3d1d6a12800` (contract: `JanusFlow`) | **DEPRECATED** |

---

## Extending the SDK

Adding a new module (e.g., HekateMixer) is purely additive. See [docs/EXTENDING.md](docs/EXTENDING.md).

---

## License

MIT — oydual3 <claucondor@gmail.com>
