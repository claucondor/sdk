# @openjanus/sdk

Unified TypeScript SDK for OpenJanus privacy primitives on Flow.

Consolidates @openjanus/babyjub, @openjanus/pedersen, and @openjanus/groth16
into a single, extensible package. Provides the cryptographic foundation for
the v2 ElGamal-on-BabyJub confidential token stack.

---

## Versioning

| Version | Status | Description |
|---------|--------|-------------|
| `^0.2.0` | **Current** | Primitives only. v1 token layer removed. Cryptographic foundation for v2 (ElGamal-on-BabyJub) stack. |
| `^0.1.0` | **Legacy (deprecated)** | v1 stack: Pedersen-hash based JanusToken/JanusFlow. Has known privacy limitation. Do not use for new apps. |

### Why v1 was deprecated

v1 used circomlib's Pedersen hash for balance commitments. While cryptographically binding and
hiding, this hash is not additively homomorphic in the value domain, and the Cadence cross-VM
wrap layer leaked plaintext amounts via standard `TokensWithdrawn` events. In multi-sender
scenarios, recipients could recover per-sender amounts — defeating the privacy goal.

v2 replaces this with ElGamal-on-BabyJub encryption (in [openjanus/contracts](https://github.com/openjanus/contracts)),
which is additively homomorphic and does not require per-sender amount knowledge to decrypt.

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

## Quick start

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
├── crypto/      computeCommitment, buildTransferProof, generateBlinding
├── primitives/  BabyJub, Pedersen, Groth16 (low-level)
├── network/     createEvmWallet, createEvmProvider, COA helpers
└── utils/       hex conversion, pi_b swap
```

> The v1 `tokens/` module (JanusToken, JanusFlow) was removed in 0.2.0.
> v2 token contracts live in [openjanus/contracts](https://github.com/openjanus/contracts).

---

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

### Primitive contracts (canonical, used by both v1 and v2)

| Contract | Address |
|----------|---------|
| BabyJub.sol | `0x2c40513b343B70f2A0B7e6Ad6F997DDa819D6f07` |
| ConfidentialTransferVerifier | `0x0085F286d89af79EC59E27CD0c5CcD1c55f42Cf5` |

### v2 token contracts (current)

See [openjanus/contracts](https://github.com/openjanus/contracts) for v2 addresses.

### v1 contracts (historical — do not use for new development)

| Contract | Address | Status |
|----------|---------|--------|
| JanusToken.sol (NATIVE demo) | `0x53F49881A1132FF4F674D2c015e35D5B07Fa1F4A` | **DEPRECATED** |
| JanusFlow.cdc (v1.1.0) | `0x28fef3d1d6a12800` | **DEPRECATED** |

---

## Extending the SDK

Adding a new module (e.g., HekateMixer) is purely additive. See [docs/EXTENDING.md](docs/EXTENDING.md).

---

## License

MIT — oydual3 <claucondor@gmail.com>
