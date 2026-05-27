# @openjanus/sdk

Generic, app-agnostic TypeScript SDK for OpenJanus confidential token primitives on Flow.

v0.3 ships **JanusFlow**, a native-FLOW confidential token with **fully shielded
transfers**: amount is hidden on calldata, events, and storage. Cleartext leaks
are confined by design to the wrap / unwrap boundary (where you exchange FLOW
for shielded balance).

---

## Install

```bash
npm install @openjanus/sdk
```

Peer dependencies (installed automatically):
- `ethers` ^6 — Flow EVM provider
- `@onflow/fcl` ^1.13 — Cadence transactions
- `circomlibjs` ^0.1.7 — BabyJubJub + Pedersen
- `snarkjs` ^0.7.6 — Groth16 proof generation

---

## Privacy properties (v0.3)

| Channel             | wrap          | shieldedTransfer | unwrap          |
|---------------------|---------------|------------------|-----------------|
| msg.value / amount  | LEAK (intentional, boundary in) | HIDE | LEAK (intentional, boundary out) |
| calldata            | LEAK at wrap  | HIDE             | LEAK at unwrap  |
| event payload       | Wrapped(amount) | ConfidentialTransfer (no amount) | Unwrapped(amount, recipient) |
| storage delta       | commitment opaque (Pedersen) | commitment opaque | commitment opaque |
| commitment hiding   | 128-bit Pedersen blinding |  |  |

Aggregate `totalLocked` is **always public** so external observers can audit
the size of the shielded pool — this is by design.

For the full privacy validation, see the lab's `v03-smoke.mjs` empirical report
and the audits-kb privacy findings linked from the migration doc.

---

## Quick start

```typescript
import {
  JanusFlow,
  buildAmountDiscloseProof,
  buildShieldedTransferProof,
  generateBlinding,
  flowToWei,
} from "@openjanus/sdk";
import { ethers } from "ethers";

// 1) Connect a signer
const provider = new ethers.JsonRpcProvider("https://testnet.evm.nodes.onflow.org");
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const flow = new JanusFlow();          // canonical testnet defaults
await flow.connectWithSigner(wallet);

// 2) Wrap 5 FLOW into the caller's hidden slot
const amountWei = flowToWei(5n);
const blinding  = generateBlinding();   // 128-bit secret — STORE LOCALLY!
const wrapProof = await buildAmountDiscloseProof({ amount: amountWei, blinding });

await flow.wrap({
  amountWei,
  txCommit: wrapProof.txCommit,         // [Cx, Cy] — convenience tuple
  amountProof: wrapProof.proof,
});

// 3) Shielded transfer of 2 FLOW — amount is HIDDEN end-to-end
const oldBlinding      = blinding;      // (the blinding from step 2)
const oldBalance       = amountWei;     // (your local accounting)
const transferAmount   = flowToWei(2n);
const transferBlinding = generateBlinding();
const newBlinding      = generateBlinding();   // store for next spend!

const transferProof = await buildShieldedTransferProof({
  oldBalance,
  oldBlinding,
  transferAmount,
  transferBlinding,
  newBlinding,
});

await flow.shieldedTransfer({
  to: "0x000000000000000000000000000000000000Babe",
  publicInputs: transferProof.publicInputs,
  proof:        transferProof.proof,
});

// 4) Unwrap 2 FLOW out of the hidden pool — recipient + amount visible
const claimedWei = flowToWei(2n);
const unwrapAmountProof = await buildAmountDiscloseProof({
  amount: claimedWei,
  blinding: transferBlinding,           // re-use the transfer's blinding
});
const unwrapTransferProof = await buildShieldedTransferProof({
  oldBalance,
  oldBlinding,
  transferAmount: claimedWei,
  transferBlinding,
  newBlinding,                          // residual blinding (your books)
});

await flow.unwrap({
  claimedAmountWei: claimedWei,
  recipient: wallet.address,
  txCommit: unwrapAmountProof.txCommit,
  amountProof: unwrapAmountProof.proof,
  transferPublicInputs: unwrapTransferProof.publicInputs,
  transferProof: unwrapTransferProof.proof,
});
```

App responsibilities (the SDK is intentionally generic):
- Persist every `(value, blinding)` pair on the user's device — the contract
  only stores the commitment, not the cleartext balance.
- Coordinate `oldBalance` / `oldBlinding` across transfers (the new state is
  always your **new** balance and the new blinding from the transfer proof).
- Bound the user's whole-FLOW arithmetic — the circuit constrains
  `transferAmount ≤ oldBalance` and `amount ∈ [0, 2^64)`.

---

## Module structure

```
@openjanus/sdk
├── tokens/      JanusToken (abstract), JanusFlow (concrete native FLOW),
│                 JanusFlowCadence (Cadence router helper)
├── crypto/      buildAmountDiscloseProof, buildShieldedTransferProof,
│                 computeCommitment, randomBabyJubScalar, FLOW unit helpers
├── primitives/  BabyJub, Pedersen, Groth16 (low-level)
├── network/     createEvmWallet, createEvmProvider, COA helpers
└── utils/       hex conversion, pi_b swap
```

Bundled Groth16 artifacts (`circuits/v0.3/`): the SDK ships production zkeys,
wasm, and verifier `.sol` so callers do not need to clone the lab.

---

## Deployed contracts (Flow testnet)

### v0.3 — generic shielded primitive (2026-05-27)

| Contract                       | Network              | Address |
|-------------------------------|----------------------|---------|
| JanusFlow (EVM proxy)         | Flow EVM testnet     | `0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078` |
| JanusFlow (EVM impl)          | Flow EVM testnet     | `0x9321dF5884021D7E19Ad0EB5F582f8E2A70236eC` |
| AmountDiscloseVerifier        | Flow EVM testnet     | `0xD0ED3936530258C278f5357C1dB709ad34768352` |
| ConfidentialTransferVerifier  | Flow EVM testnet     | `0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B` |
| BabyJub.sol                   | Flow EVM testnet     | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` |
| JanusFlow.cdc (router)        | Flow Cadence testnet | `0x5dcbeb41055ec57e` |
| Owner (admin COA, EVM)        | Flow EVM testnet     | `0x0000000000000000000000022f6b30af48a94787` |

Trusted setup (v0.3): Hermez `pot14` (200+ contributors) + two named phase-2
contributors + Flow VRF beacon at testnet block `323723000`. Full provenance
chain (sha256 of every contribution) lives in
`circuits/v0.3/CEREMONY-RECORD.json` which the SDK ships unmodified.

### Deprecated (DO NOT USE — leaked amount privacy)

| Old contract                         | Address                                       | Why deprecated |
|--------------------------------------|-----------------------------------------------|----------------|
| v0.2 JanusToken (ElGamal accumulator) | `0x025efe7e89acdb8F315C804BE7245F348AA9c538`  | shieldedTransfer leaked cleartext `transferUnits` |
| v0.2 EncryptConsistencyVerifier       | `0x0C1e731036f4632CF9620bf6C6BB8204eD3a3B1e`  | only consumed by the v0.2 proxy |
| v0.2 DecryptOpenVerifier              | `0x1c248dA94aab9f4A03005E7944a8b745a6236Dbc`  | only consumed by the v0.2 proxy |
| v0.2 Cadence router                   | `0xbef3c77681c15397`                          | bound to v0.2 EVM target |
| v1 Cadence Pedersen zombie            | `0x28fef3d1d6a12800`                          | Flow protocol can't remove old contracts |

See `MIGRATION-v0.3.md` for step-by-step migration.

---

## Tests

```bash
# Unit tests (no network, ~3 seconds; ~30s with real proofs)
npm test
SKIP_PROOF_TESTS=1 npm test    # skip the snarkjs proof tests

# Integration tests (read-only Flow testnet)
RUN_INTEGRATION=1 npm run test:integration

# All
npm run test:all
```

---

## License

MIT — oydual3 <claucondor@gmail.com>
