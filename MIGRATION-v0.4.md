# Migrating to @openjanus/sdk v0.4.0

**v0.4.0 is fully additive — there are NO breaking changes.** All v0.3 imports
keep working unchanged. You only need to read this guide if you want to
adopt the new multi-token primitives.

---

## What's new

### `JanusERC20` — confidential ERC20-wrapping token on Flow EVM

A second concrete `JanusToken` subclass, deployed to Flow EVM testnet at
`0xf2C04b1A32B815ac7Ffd87a4C312096592BBCa1e`. Wraps an arbitrary ERC20
underlying (MockUSDC by default on testnet). Same shielded-transfer privacy
as `JanusFlow`, but the wrap boundary is an `approve + transferFrom` pattern
rather than `msg.value`.

```ts
import { JanusERC20, JANUS_ERC20_MOCK_USDC_ADDRESS } from "@openjanus/sdk";

const usdc = new JanusERC20();                  // canonical testnet defaults
await usdc.connectWithSigner(wallet);

// 1. Approve the proxy on the underlying ERC20:
//    (call underlying.approve(usdc.address, amount) via your normal ERC20 SDK)

// 2. Wrap with an amount-disclose proof:
const wrapResult = await usdc.wrap({
  amountRaw: 1_000_000n,                        // 1 USDC at 6 decimals
  txCommit: [proof.commit.x, proof.commit.y],
  amountProof: proof.proof,
});

// 3. Shielded transfer (HIDDEN amount):
await usdc.shieldedTransfer({ to, publicInputs, proof });

// 4. Unwrap (boundary leak — amount + recipient visible):
await usdc.unwrap({
  claimedAmountRaw: 500_000n,
  recipient: someAddress,
  txCommit, amountProof,
  transferPublicInputs, transferProof,
});
```

#### Underlying token note

Flow EVM testnet does **not** have a canonical USDC. The v0.4 deployment pins
its underlying to `MockUSDC` at `0x3e8973dE565743Ef9748779bE377BBE050A13C22`
— a permissionlessly-mintable 6-decimal placeholder. Apps developing against
the testnet deployment can mint via `mockUsdc.mint(addr, amount)` from the
exported `ERC20_MINIMAL_ABI`. For mainnet, deploy a fresh `JanusERC20Proxy`
pinned to your real ERC20 underlying.

### `JanusFTCadence` — Cadence-side FungibleToken wrapper

A Cadence-only confidential-amount wrapper for any `FungibleToken` vault.
Deployed at `0xbef3c77681c15397` (`openjanus-flow`) with default underlying
`A.7e60df042a9c0868.FlowToken.Vault`.

```ts
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

#### v0.4 limitations (porting from the lab spike)

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

## New exports

```ts
// Concrete token classes
JanusERC20, JanusFTCadence

// JanusERC20 constants + ABI
JANUS_ERC20_TESTNET
JANUS_ERC20_EVM_ADDRESS
JANUS_ERC20_EVM_IMPL_ADDRESS
JANUS_ERC20_MOCK_USDC_ADDRESS
JANUS_ERC20_VERSION
JANUS_ERC20_MAX_WRAP_RAW
JANUS_ERC20_EXTRA_ABI
ERC20_MINIMAL_ABI

// JanusFT constants + Cadence templates
JANUS_FT_CADENCE_ADDRESS
JANUS_FT_CONTRACT_NAME
JANUS_FT_VERSION
JANUS_FT_DEFAULT_UNDERLYING_TYPE
JANUS_FT_SMOKE_MIRROR_ADDRESS
TX_FT_SETUP_REGISTRY
TX_FT_WRAP
TX_FT_SHIELDED_TRANSFER
TX_FT_UNWRAP
SCRIPT_FT_GET_TOTAL_LOCKED
SCRIPT_FT_GET_COMMITMENT
SCRIPT_FT_GET_UNDERLYING_TYPE
buildJanusFTTx                  // helper to re-target a template to a non-canonical address

// New types
JanusERC20ConstructorOptions
JanusFTCadenceOptions
```

---

## Reused primitives (no change from v0.3)

The v0.4 token deployments **reuse** these contract addresses:

| Primitive | Address | Status |
|-----------|---------|--------|
| BabyJub.sol | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` | REUSED |
| AmountDiscloseVerifier | `0xD0ED3936530258C278f5357C1dB709ad34768352` | REUSED (v0.3 ceremony) |
| ConfidentialTransferVerifier | `0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B` | REUSED (v0.3) |
| Admin COA owner | `0x0000000000000000000000022f6b30af48a94787` | REUSED |

The same circuits + zkey artifacts in `circuits/v0.3/` are used by all three
EVM-side concrete tokens (`JanusFlow`, `JanusERC20`). `JanusFT` does NOT yet
call the verifiers — that wiring lands in v0.5.

---

## Roadmap to v0.5

- `JanusFT` cross-VM port: replace stub helpers with COA calls to
  `BabyJub.sol`; verify proofs via the EVM `ConfidentialTransferVerifier`.
- `JanusERC20` Cadence router (mirror of the existing `JanusFlow` router at
  `0x5dcbeb41055ec57e`) so apps can wrap/unwrap ERC20s from Cadence
  transactions without writing their own COA plumbing.
- Production-ready `JanusERC20` with a real ERC20 underlying (e.g. canonical
  USDC once available on Flow EVM).
