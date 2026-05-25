# v1 vs v2 — When to Use Each

This document explains the difference between the v1 (Pedersen) and v2 (ElGamal) stacks and helps you decide which to use.

## TL;DR

**Use v2 for new apps.** v2 solves the fundamental privacy limitation of v1: in v1, a recipient who receives tips from multiple senders can deduce individual sender amounts from the on-chain data. v2 eliminates this leak.

| | v1 (Pedersen) | v2 (ElGamal) |
|--|---------------|-------------|
| Module | `@openjanus/sdk/tokens` | `@openjanus/sdk/tokens-v2` |
| Classes | `JanusToken`, `JanusFlow` | `JanusTokenV2`, `JanusFlowV2` |
| Commitment type | Pedersen `C = m*G + r*H` | ElGamal `(c1, c2) = (r*G, m*G + r*PK)` |
| Multi-sender privacy | NO — slot is a single commitment | YES — ciphertexts accumulate homomorphically |
| Recipient can learn per-sender amounts | YES (privacy failure in v1) | NO (confirmed 24/24 Phase 3) |
| Blinding factor coordination | Sender stores own blinding factor | None — encrypt directly to recipient PK |
| Recipient decryption | Brute-force DLOG (small amounts only) | BSGS solver — practical for up to ~10M |
| One-time setup | None | `registerPubkey()` once per account |
| Gas (EVM verify) | ~250k gas | ~300k gas |

## When to keep using v1

- **Existing deployed apps** — if you have a live v1 JanusFlow instance with users, there is no migration path other than a full re-deployment. v1 contracts remain operational.
- **Single-sender scenarios** — if only one sender ever deposits to a given recipient, v1's privacy property holds. The leak only appears with multiple senders.
- **Smaller amount ranges** — v1's brute-force decrypt is practical for amounts < 10,000. v2 BSGS handles up to ~10M but requires more setup.

## When to use v2 (new apps)

- **Tip or donation use cases** — multiple senders per recipient, amount totals visible but individual amounts hidden
- **Payroll/payouts** — employer pays multiple employees from a single contract without amounts being linkable
- **Privacy-first design** — you want the strongest available privacy property on Flow today
- **PrivateTip** — the canonical v2 use case; uses JanusFlowV2 for cross-VM FLOW wrapping

## Architecture differences

### v1: Pedersen commitments

```
Balance slot = C = m*G + r*H   (one point per user)

Adding a transfer:
  new_slot = old_slot + transfer_commitment   (homomorphic addition)
```

Problem: `C = m*G + r*H` is a commitment to `(m, r)`. The commitment scheme used in circomlib is multi-base — only the holder of `r` can open it. But when multiple senders add to the same slot, each sender's blinding factor is embedded in the slot. With multiple additions, the recipient can isolate individual contributions.

### v2: ElGamal ciphertexts

```
Balance slot = (C1, C2) = (r*G, m*G + r*PK)   (two points per user)

Sender encrypts to recipient PK:
  c1 = r * G                  (ephemeral — random per send)
  c2 = m*G + r*PK             (masked message point)

Multiple senders accumulate:
  (C1_acc, C2_acc) += (c1_new, c2_new)   (component-wise BabyJub addition)

Recipient decrypts:
  M = C2_acc - sk * C1_acc    (recover m*G for accumulated total)
  m = BSGS(M)                 (solve DLOG via Baby-Step Giant-Step)
```

The key insight: each sender uses independent randomness `r`. The accumulated `(C1_acc, C2_acc)` reveals nothing about individual `r_i` values. Only the recipient's `sk` can decrypt.

## Code migration

### v1 → v2: JanusToken (EVM-only)

```typescript
// v1
import { JanusToken, JANUS_TOKEN_TESTNET } from "@openjanus/sdk/tokens";
const token = new JanusToken(JANUS_TOKEN_TESTNET);
await token.connect();
const commit = await token.balanceOfCommitment(address);

// v2
import { JanusTokenV2, JANUS_TOKEN_V2_TESTNET } from "@openjanus/sdk/tokens-v2";
const token = new JanusTokenV2(JANUS_TOKEN_V2_TESTNET);
await token.connect();
const ciphertext = await token.getBalanceCiphertext(address);
```

### v1 → v2: JanusFlow (Cadence)

```typescript
// v1: wrap with Pedersen commitment
await sdk.wrap(
  "10.0",       // UFix64 amount
  10n,          // raw bigint
  blinding,     // 128-bit blinding factor — sender must store this
  authz
);

// v2: wrap + encrypt to recipient pubkey (no blinding factor needed)
const proofResult = await buildEncryptProof({
  amount: 10n,
  randomness: generateRandomness(),  // ephemeral, not stored
  recipientPubkey: alicePK,          // Alice's registered BabyJub pubkey
  wasmPath, zkeyPath,
});
await sdk.wrapAndEncrypt("10.0", ALICE_CADENCE_ADDR, proofResult, authz);
```

### v1 → v2: keypair setup

```typescript
// v1: no keypair needed — commitments are blinding-based
const blinding = generateBlinding(); // store per-commitment

// v2: one keypair per account — derived once from account key
import { ElGamalKeypair } from "@openjanus/sdk/tokens-v2";
// derive sk from Flow account key material (see primitives/babyjub for scalar derivation)
const aliceKeypair: ElGamalKeypair = { sk: derivedSk, pk: sk * G };
await sdk.registerPubkey(aliceKeypair.pk, authz); // one-time registration
```

## Choosing based on your use case

| Use case | Recommended | Why |
|----------|-------------|-----|
| New tipping/donation app | v2 | Multi-sender privacy is essential |
| Existing v1 app upgrade | Keep v1 | No migration path for live slots |
| Privacy payroll | v2 | Multiple payers, recipient privacy |
| Simple single-sender wrap | Either | v1 simpler if single sender only |
| PrivateTip | v2 | Canonical v2 use case |
| Research/exploration | v2 | Stronger primitive, more future-proof |

## Deployed addresses

### v1
- JanusToken.sol: `0x53F49881A1132FF4F674D2c015e35D5B07Fa1F4A`
- JanusFlow.cdc: `0x28fef3d1d6a12800` (contract: `JanusFlow`)

### v2
- JanusTokenV2.sol: `0xC715b3647536F671Aa25A6B6Ea1d7f5a0b9fA63D`
- JanusFlowV2.cdc: `0x28fef3d1d6a12800` (contract: `JanusFlowV2`)
- EncryptConsistencyVerifier: `0x6F8Cc93dd6aA7B3ED0a3DaA75271815558ad9b5C`
- DecryptOpenVerifier: `0x3bB139B5404fD6b152813bC3532367AAa096638b`
- BabyJub.sol: `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870`
