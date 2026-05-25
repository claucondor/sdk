# @openjanus/sdk

Unified TypeScript SDK for OpenJanus privacy primitives on Flow.

Consolidates @openjanus/babyjub, @openjanus/pedersen, @openjanus/groth16,
and @openjanus/janus-token into a single, extensible package.

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

### Read a JanusToken balance

```typescript
import { JanusToken, JANUS_TOKEN_TESTNET } from "@openjanus/sdk";

const token = new JanusToken(JANUS_TOKEN_TESTNET);
await token.connect();

const commit = await token.balanceOfCommitment("0xAliceAddress");
// identity (0, 1) means zero balance
console.log(commit); // { x: 0n, y: 1n }
```

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

### JanusFlow wrap + transfer (Cadence)

```typescript
import { JanusFlow } from "@openjanus/sdk";

const sdk = new JanusFlow({ network: "testnet" });
await sdk.configure();

// Wrap 10 FLOW
const { txId: wrapTx, commitment } = await sdk.wrap(
  "10.0",
  10n,
  aliceBlinding,
  aliceAuthz  // FCL authorization function
);
console.log("Wrap TX:", wrapTx);

// Transfer 3 FLOW to Bob
const { txId: transferTx } = await sdk.confidentialTransfer(
  BOB_CADENCE_ADDRESS,
  {
    oldBalance: 10n,
    oldBlinding: aliceBlinding,
    transferAmount: 3n,
    transferBlinding: generateBlinding(),
    newBlinding: generateBlinding(),
    wasmPath,
    zkeyPath,
  },
  aliceAuthz
);
console.log("Transfer TX:", transferTx);
```

---

## Module structure

```
@openjanus/sdk
├── tokens/      JanusToken (EVM NATIVE), JanusFlow (Cadence WRAPPER)
├── crypto/      computeCommitment, buildTransferProof, generateBlinding
├── primitives/  BabyJub, Pedersen, Groth16 (low-level)
├── network/     createEvmWallet, createEvmProvider, COA helpers
└── utils/       hex conversion, pi_b swap
```

---

## Examples

```bash
# Print commitment math and SDK API usage (no network required)
npx ts-node --esm examples/basic-transfer.ts
npx ts-node --esm examples/multi-wrap.ts
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

| Contract | Address |
|----------|---------|
| BabyJub.sol | 0x2c40513b343B70f2A0B7e6Ad6F997DDa819D6f07 |
| ConfidentialTransferVerifier | 0x0085F286d89af79EC59E27CD0c5CcD1c55f42Cf5 |
| JanusToken.sol (NATIVE demo) | 0x53F49881A1132FF4F674D2c015e35D5B07Fa1F4A |
| JanusFlow.cdc (v1.1.0) | 0x28fef3d1d6a12800 |

---

## Extending the SDK

Adding a new module (e.g., HekateMixer) is purely additive. See [docs/EXTENDING.md](docs/EXTENDING.md).

---

## License

MIT — oydual3 <claucondor@gmail.com>
