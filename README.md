# @openjanus/sdk

Privacy primitives for the Flow blockchain.

Send FLOW without revealing the amount. Run a private payroll. Accept donations
with hidden values. All using your existing Flow wallet — no new tools required.

OpenJanus is **Cadence-first**: privacy lives in Cadence-native flows that
settle through Flow EVM. The EVM is the implementation detail, not the product
surface. Think of it as a doorway: you stand on the Cadence side, and the ZK
machinery lives quietly beneath the threshold.

---

## Quick start

```bash
npm install @openjanus/sdk
```

```typescript
import {
  JanusFlow,
  buildAmountDiscloseProof,
  buildShieldedTransferProof,
  generateBlinding,
  flowToWei,
} from "@openjanus/sdk";
import { ethers } from "ethers";

// 1. Connect
const provider = new ethers.JsonRpcProvider("https://testnet.evm.nodes.onflow.org");
const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const flow     = new JanusFlow();
await flow.connectWithSigner(wallet);

// 2. Wrap 5 FLOW — amount visible at the boundary, hidden everywhere after
const amountWei = flowToWei(5n);                   // 5 * 10^18
const blinding  = generateBlinding();               // 128-bit secret — STORE LOCALLY
const wrapProof = await buildAmountDiscloseProof({ amount: amountWei, blinding });

await flow.wrap({
  amountWei,
  txCommit:    wrapProof.txCommit,
  amountProof: wrapProof.proof,
});

// 3. Shielded transfer — amount HIDDEN in calldata, events, and storage
const transferAmount   = flowToWei(2n);
const transferBlinding = generateBlinding();
const newBlinding      = generateBlinding();         // store: your new residual blinding

const xferProof = await buildShieldedTransferProof({
  oldBalance:       amountWei,
  oldBlinding:      blinding,
  transferAmount,
  transferBlinding,
  newBlinding,
});

await flow.shieldedTransfer({
  to:           "0x000000000000000000000000000000000000Babe",
  publicInputs: xferProof.publicInputs,
  proof:        xferProof.proof,
});

// 4. Unwrap — amount + recipient visible at the boundary
const exitAmount      = flowToWei(3n);               // your residual
const exitBlinding    = generateBlinding();
const amountExit      = await buildAmountDiscloseProof({ amount: exitAmount, blinding: newBlinding });
const transferExit    = await buildShieldedTransferProof({
  oldBalance:       amountWei - transferAmount,      // local accounting
  oldBlinding:      newBlinding,
  transferAmount:   exitAmount,
  transferBlinding: exitBlinding,
  newBlinding:      0n,                              // empties the slot
});

await flow.unwrap({
  claimedAmountWei:    exitAmount,
  recipient:           wallet.address,
  txCommit:            amountExit.txCommit,
  amountProof:         amountExit.proof,
  transferPublicInputs: transferExit.publicInputs,
  transferProof:       transferExit.proof,
});
```

For the visual explanation of the underlying primitives, see [PrivateTip /learn](https://github.com/openjanus/private-tip).

---

## Privacy properties

| Channel | wrap | shieldedTransfer | unwrap |
|---|---|---|---|
| msg.value | LEAK (boundary in) | HIDE | LEAK (boundary out) |
| calldata | LEAK at wrap | HIDE | LEAK at unwrap |
| events | `Wrapped(amount)` | `ConfidentialTransfer` (no amount) | `Unwrapped(amount, recipient)` |
| storage | commitment opaque (Pedersen) | commitment opaque | commitment opaque |
| commitment | 128-bit Pedersen blinding | 128-bit Pedersen blinding | 128-bit Pedersen blinding |

Aggregate `totalLocked` is **always public** — external observers can audit the
pool size at any time. This is intentional boundary accounting.

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

Three concrete confidential tokens ship with the SDK. Privacy semantics are
identical across all three — the difference is the underlying asset and the
wrapping mechanism.

| Token | Underlying | Recommended for |
|---|---|---|
| **`JanusFlow`** | Native FLOW | Cadence apps tipping / paying in FLOW |
| `JanusFTCadence` | Any FungibleToken vault | Cadence-native FT integrations |
| `JanusERC20` | ERC20 (MockUSDC on testnet) | EVM-DeFi apps |

Most apps want **JanusFlow**.

---

## JanusFlow — native FLOW (recommended)

Deployed as a UUPS proxy at `0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078` on
Flow EVM testnet, with a Cadence router façade at `0x5dcbeb41055ec57e`. Users
sign normal Cadence transactions; the router orchestrates the cross-VM EVM call
via the signer's COA.

The full end-to-end walkthrough is in the [Quick start](#quick-start) above.
Condensed notes on the caller's responsibilities:

- **Persist every `(value, blinding)` pair** on the user's device. The contract
  stores only the Pedersen commitment — the cleartext balance lives locally.
- **Track `oldBalance` / `oldBlinding`** across transfers. After each
  `shieldedTransfer` your new balance is `oldBalance − transferAmount` and your
  new blinding is `newBlinding` (the one you passed to `buildShieldedTransferProof`).
- **Amount range**: `transferAmount ≤ oldBalance` and `amount ∈ [0, 2^128)` —
  effectively unbounded for any realistic use.

### JanusFTCadence — any Cadence FungibleToken

Cadence-only confidential-amount wrapper. Deployed at `0xbef3c77681c15397`.

```typescript
import { JanusFTCadence, TX_FT_WRAP, TX_FT_SHIELDED_TRANSFER } from "@openjanus/sdk";

const ft = await new JanusFTCadence({ network: "testnet" }).configure();
const totalLocked = await ft.getTotalLocked();
const commit      = await ft.balanceOfCommitment(someAddress);

// State-changing flows use FCL — pass the exported templates:
//   await fcl.mutate({ cadence: TX_FT_WRAP, args: ... })
```

### JanusERC20 — ERC20 on Flow EVM (advanced)

Wraps an arbitrary ERC20 underlying. Deployed at
`0xf2C04b1A32B815ac7Ffd87a4C312096592BBCa1e` (pinned to `MockUSDC` — Flow EVM
testnet has no canonical USDC). Same shielded-transfer privacy as JanusFlow;
the wrap boundary is `approve + transferFrom` rather than `msg.value`.

```typescript
import { JanusERC20 } from "@openjanus/sdk";

const usdc = new JanusERC20();
await usdc.connectWithSigner(wallet);

// Approve first: underlying.approve(usdc.address, amount)
await usdc.wrap({
  amountRaw:   1_000_000n,             // 1 USDC at 6 decimals
  txCommit:    [proof.commit.x, proof.commit.y],
  amountProof: proof.proof,
});
await usdc.shieldedTransfer({ to, publicInputs, proof });
```

---

## ShieldedNote

Every shielded transfer creates a Pedersen commitment delta `C_tx` — but the
recipient only receives an elliptic-curve point. To later spend or unwrap, they
need the plaintext `(amount, blinding)` pair that produced it. ShieldedNote is
the canonical encrypted channel for shipping that payload alongside the transfer.

```typescript
import {
  encryptShieldedNote,
  decryptShieldedNote,
  generateBabyJubKeypair,
} from "@openjanus/sdk";

// Sender: encrypt the note to the recipient's BabyJub pubkey
const note = {
  amount:   transferAmount,     // bigint, wei
  blinding: transferBlinding,   // bigint, 128-bit secret
  data:     "Thanks for the help last week!",  // optional UTF-8 app payload
};
const ciphertext = await encryptShieldedNote(note, recipientPubkey);
// Attach ciphertext to your shielded transfer transaction

// Recipient: decrypt on arrival
const decoded = await decryptShieldedNote(
  ciphertext.ciphertext,
  ciphertext.ephemeralPubkey,
  recipientPrivkey,
);
// decoded.amount, decoded.blinding, decoded.data — all available
```

The wire format is versioned JSON (`{"v":1,"a":"...","b":"...","d":"..."}`)
encrypted with ECIES + AES-GCM over BabyJubJub.

PrivateTip uses this to carry the memo text + blinding end-to-end. For the
theory, see the `/learn` page in the [PrivateTip demo](https://github.com/openjanus/private-tip).

---

## Sign-derive: multi-device key recovery

`generateBabyJubKeypair()` generates a fresh random scalar every call — correct
for ephemeral ECIES keys, wrong for a user's persistent MemoKey. The sign-derive
pattern solves this: derive the MemoKey deterministically from a wallet signature
so any device with the same wallet recovers the same key.

```typescript
import { deriveBabyJubKeypairFromBytes } from "@openjanus/sdk";
import { ethers } from "ethers";

// Prompt the user to sign a fixed message — the signature is the entropy source
const sig      = await wallet.signMessage("OpenJanus MemoKey v1");
const sigBytes = ethers.getBytes(sig);   // 65-byte Uint8Array

// Same wallet → same keypair, on any device, forever
const memoKey = await deriveBabyJubKeypairFromBytes(sigBytes, "openjanus/memokey/v1");
// { privkey: bigint, pubkey: { x: bigint, y: bigint } }

// Publish memoKey.pubkey so senders can encrypt notes to you
// Keep memoKey.privkey in memory only — never persisted, never on-chain
```

The context string provides domain separation — you can derive independent keys
from the same signature:
```
"openjanus/memokey/v1"   → persistent memo-encryption key
"openjanus/viewkey/v1"   → read-only audit key (future)
"openjanus/spendkey/v1"  → spend-authorization key (future)
```

Under the hood: HKDF-SHA256 over 64 bytes, reduced mod the BabyJub subgroup
order, giving < 2^-127 statistical bias. Same pattern used by Phantom / Argent /
Rabby for non-custodial encrypted messaging.

---

## Module structure

```
@openjanus/sdk
├── tokens/      JanusToken (abstract), JanusFlow (recommended),
│                 JanusFTCadence, JanusFlowCadence (router helper),
│                 JanusERC20 (advanced)
├── crypto/      buildAmountDiscloseProof, buildShieldedTransferProof,
│                 computeCommitmentV05, encryptShieldedNote, decryptShieldedNote,
│                 deriveBabyJubKeypairFromBytes, generateBabyJubKeypair,
│                 generateBlinding, encryptText, decryptText, flowToWei, weiToFlow
├── primitives/  BabyJub, Pedersen, Groth16 (low-level)
├── network/     createEvmProvider, createEvmWallet, COA helpers
└── utils/       formatPoint, isValidFlowAddress, parseFlowToWei, hex helpers
```

---

## Deployed contracts (Flow testnet)

| Contract | Network | Address |
|---|---|---|
| JanusFlow proxy | Flow EVM testnet | `0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078` |
| JanusFlow impl | Flow EVM testnet | `0xa2607E9EAb1718a2fAf5a1328A7d3a9Aa854efff` |
| AmountDiscloseVerifier | Flow EVM testnet | `0x9c83b2b1EFFD3bd375b9Bee93Cb618005D6A2Dc4` |
| ConfidentialTransferVerifier | Flow EVM testnet | `0x48f791D2a4992F448Cc36F12e5500b6553e969b3` |
| BabyJub.sol | Flow EVM testnet | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` |
| JanusFlow.cdc router | Flow Cadence testnet | `0x5dcbeb41055ec57e` |
| JanusFTCadence | Flow Cadence testnet | `0xbef3c77681c15397` |
| JanusERC20 proxy | Flow EVM testnet | `0xf2C04b1A32B815ac7Ffd87a4C312096592BBCa1e` |
| JanusERC20 impl | Flow EVM testnet | `0x7FE0B05ED77E0540519B6f10DD4b4521e867590D` |
| MockUSDC (test underlying) | Flow EVM testnet | `0x3e8973dE565743Ef9748779bE377BBE050A13C22` |
| Admin owner (COA, EVM) | Flow EVM testnet | `0x0000000000000000000000022f6b30af48a94787` |

---

## Trusted setup

The Groth16 verifiers are backed by a two-phase ceremony:

- **Phase 1 (universal)**: `powersOfTau28_hez_final_18.ptau` — Hermez pot18
  transcript, 200+ contributors via the Polygon community. Canonical source:
  `https://storage.googleapis.com/zkevm/ptau/`.
- **Phase 2 (circuit-specific)**: one named contributor, entropy from
  `openssl rand -hex 32` not logged per protocol.
- **Beacon randomness**: Flow VRF, testnet block `324,226,714`, block ID
  `6e470bc1fc410b1a12b72991da0a8b4d7cfc5c8872eff0a3d57ae0c8ecffdc7a`.
- **Full provenance**: contribution hashes, beacon hash, and `ZKey Ok!` verification
  results live in `circuits/CEREMONY-RECORD.json` (shipped with the SDK).

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
