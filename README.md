# @openjanus/sdk

Privacy primitives for the Flow blockchain.

Tip your favorite creator without revealing how much you sent. Run a private
payroll on-chain. Receive donations with hidden amounts. All using your
existing Flow wallet — no new tools required.

OpenJanus is **Cadence-first**: privacy lives in Cadence-native flows that
happen to settle through Flow EVM. The EVM is the implementation detail, not
the product surface.

---

## Quick start (most users start here)

```typescript
import { JanusFlow } from "@openjanus/sdk/tokens";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://testnet.evm.nodes.onflow.org");
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const flow = new JanusFlow();           // canonical testnet defaults
await flow.connectWithSigner(wallet);

// Shielded tip of 5 FLOW — amount HIDDEN end-to-end after the wrap
await flow.wrap({ amountWei: 5_000_000_000_000_000_000n, /* + proof */ });
await flow.shieldedTransfer({ to: charlieCoaHex, /* + proof */ });
```

For the full end-to-end walk-through (proof generation, blinding management,
unwrap), see the [JanusFlow section](#janusflow--native-flow-recommended)
below.

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

## Token primitives

OpenJanus ships three concrete confidential tokens. Pick the one that matches
your asset — privacy semantics are identical across all three.

| Token                | Layer    | Underlying              | Recommended for                                | Status      |
|----------------------|----------|-------------------------|------------------------------------------------|-------------|
| **`JanusFlow`**      | EVM      | Native FLOW             | Cadence apps tipping / paying in FLOW          | Production  |
| **`JanusFTCadence`** | Cadence  | Any FungibleToken vault | Cadence-native FT integrations                 | Lab-grade   |
| `JanusERC20`         | EVM      | ERC20 (MockUSDC on testnet) | EVM-DeFi apps wrapping native ERC20s       | Production  |

Most apps want **JanusFlow**. Use `JanusFTCadence` if your app already speaks
Cadence FungibleToken. `JanusERC20` is advanced — see below.

### JanusFlow — Native FLOW (recommended)

Deployed at `0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078` (Flow EVM testnet)
with a Cadence router façade at `0x5dcbeb41055ec57e`. Users sign normal
Cadence transactions; the router orchestrates the cross-VM EVM call via the
signer's COA.

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

### JanusFTCadence — any Cadence FungibleToken

A Cadence-only confidential-amount wrapper for any `FungibleToken` vault.
Deployed at `0xbef3c77681c15397` (`openjanus-flow`) with default underlying
`A.7e60df042a9c0868.FlowToken.Vault`.

Use this when your app already issues / consumes Cadence Fungible Tokens
and you want to add privacy without bridging to EVM.

```typescript
import {
  JanusFTCadence,
  TX_FT_SETUP_REGISTRY, TX_FT_WRAP, TX_FT_SHIELDED_TRANSFER,
} from "@openjanus/sdk";

const ft = await new JanusFTCadence({ network: "testnet" }).configure();
const totalLocked = await ft.getTotalLocked();
const commit = await ft.balanceOfCommitment(someAddress);

// State-changing flows are FCL transactions — pass the exported templates:
//   await fcl.mutate({ cadence: TX_FT_WRAP, args: ... })
```

#### v0.4 lab-grade caveats

- **Stub crypto.** `babyAddStub` and `babyNegateStub` are not real BabyJubJub
  point ops — they hash coordinates so the output is opaque to a byte-level
  observer. This is enough to validate the **structural** privacy properties
  (calldata, events, storage shape), but accumulated state overflows
  `UInt256` after enough operations. Real BabyJub homomorphic state lands in
  v0.5 via cross-VM calls to the EVM `BabyJub.sol`.
- **Opaque proofs.** `amountProofBytes` / `proofBytes` are accepted as long
  as `length > 0`. Real Groth16 verification arrives in v0.5 (cross-VM call
  to the EVM `ConfidentialTransferVerifier`).
- **Registry locality.** The `CommitmentRegistry` resource must live on the
  signer's account (lab spike model). Multiple distinct accounts CAN still
  hold commitments via `shieldedTransfer` — recipients don't need a registry
  resource of their own.
- **Unwrap broken on stub crypto.** The smoke test intentionally skips
  unwrap because `babyNegateStub + babyAddStub` deterministically overflow
  during `totalSupplyCommitment` debit. Working unwrap arrives in v0.5.

---

## Advanced

### JanusERC20 — native ERC20 on Flow EVM

> Most users don't need this — use **JanusFlow** (for FLOW) or
> **JanusFTCadence** (for Cadence FungibleTokens) instead.

`JanusERC20` is the second EVM-side concrete `JanusToken`. It wraps an
arbitrary ERC20 underlying instead of native FLOW. Use this when you are
building a DeFi app on Flow EVM that already speaks ERC20 (e.g. integrating
with a stablecoin) and you want shielded amounts on a pure-EVM workflow.

Deployed to Flow EVM testnet at `0xf2C04b1A32B815ac7Ffd87a4C312096592BBCa1e`
(pinned to `MockUSDC` underlying — Flow EVM testnet does not have a canonical
USDC). Same shielded-transfer privacy as `JanusFlow`; the wrap boundary is an
`approve + transferFrom` pattern rather than `msg.value`.

```ts
import { JanusERC20 } from "@openjanus/sdk";

const usdc = new JanusERC20();                  // canonical testnet defaults
await usdc.connectWithSigner(wallet);

// 1. Approve the proxy on the underlying ERC20:
//    underlying.approve(usdc.address, amount) via your normal ERC20 SDK

// 2. Wrap with an amount-disclose proof:
await usdc.wrap({
  amountRaw: 1_000_000n,                        // 1 USDC at 6 decimals
  txCommit: [proof.commit.x, proof.commit.y],
  amountProof: proof.proof,
});

// 3. Shielded transfer (HIDDEN amount):
await usdc.shieldedTransfer({ to, publicInputs, proof });
```

For mainnet, deploy a fresh `JanusERC20Proxy` pinned to your real ERC20
underlying (the proxy is one-instance-per-underlying — to wrap a second ERC20,
deploy a second proxy).

See [`MIGRATION-v0.4.md`](./MIGRATION-v0.4.md) for the full API including
`unwrap` and operational notes.

---

## Module structure

```
@openjanus/sdk
├── tokens/      JanusToken (abstract), JanusFlow (recommended),
│                 JanusFTCadence, JanusFlowCadence (router helper),
│                 JanusERC20 (advanced)
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

### v0.4 — multi-token (additive over v0.3)

| Contract                       | Network              | Address |
|-------------------------------|----------------------|---------|
| JanusFTCadence (canonical)    | Flow Cadence testnet | `0xbef3c77681c15397` |
| JanusERC20 (EVM proxy)        | Flow EVM testnet     | `0xf2C04b1A32B815ac7Ffd87a4C312096592BBCa1e` |
| JanusERC20 (EVM impl)         | Flow EVM testnet     | `0x7FE0B05ED77E0540519B6f10DD4b4521e867590D` |
| MockUSDC (test underlying)    | Flow EVM testnet     | `0x3e8973dE565743Ef9748779bE377BBE050A13C22` |

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
| v0.2 Cadence router                   | `0xbef3c77681c15397` (JanusFlow contract only) | bound to v0.2 EVM target |
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
