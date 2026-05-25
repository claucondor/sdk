# Why v1 Was Deprecated

## Summary

JanusToken v1 (Pedersen-hash based) was deprecated in `@openjanus/sdk@0.2.0` because it did not
deliver the privacy property it promised in multi-sender scenarios. v2 (ElGamal-on-BabyJub) fixes
this. We caught the issue before production users were affected.

---

## What v1 Was

v1 was a confidential token system on Flow. The idea: wrap FLOW tokens, hide the amounts using
Pedersen commitments, and use Groth16 ZK proofs to verify transfers are valid without revealing
amounts. The Cadence contract (`JanusFlow.cdc`) orchestrated cross-VM calls to the EVM contract
(`JanusToken.sol`).

The promise: "Tip amounts are private — nobody can see how much Alice sent to Bob."

---

## What Property Actually Held

The commitment hid amounts from casual on-chain observers reading EVM state directly.

Single-sender scenarios worked as described: one sender, one recipient, the amount was not
visible from reading the EVM commitment slot.

---

## Where the Gap Was

The gap appeared in **multi-sender scenarios** — the primary use case for tipping and streaming
payments.

Two problems combined:

**Problem 1 — Cadence event leakage.** The Cadence `wrap` transaction calls
`flowVault.withdraw(amount: amount)`, where `amount` is a plaintext `UFix64`. Flow's standard
`FungibleToken` interface emits `TokensWithdrawn(amount: <value>, from: <address>)` events for
every vault operation. Any chain indexer can see exactly how much FLOW each sender deposited and
correlate it to the `JanusFlow.wrap(...)` call on the same transaction. The EVM-level commitment
hiding is irrelevant if the Cadence layer emits the plaintext amount.

**Problem 2 — Commitment structure.** circomlib's Pedersen hash (used in v1) is a multi-base hash
function, not a two-generator EC commitment of the form `m*G + r*H`. This means the commitment
slot does not behave like `Commit(m1) + Commit(m2) = Commit(m1+m2)` in the way that would let a
recipient decrypt a cumulative total from multiple senders. Recipients needed to know each
individual sender's `(amount, blinding)` pair to verify their accumulated balance — which defeats
the stated privacy model for donation/tipping use cases.

---

## Why This Wasn't Caught in Early Testing

Early tests used single-sender flows (one Alice, one Bob) and focused on the EVM commitment
property. The Cadence event log was not checked as part of the privacy test suite. Multi-sender
privacy tests were added in v2 validation and confirmed the fix.

---

## How v2 Fixes It

v2 uses **ElGamal encryption on BabyJubJub**:

- The sender computes `(c1, c2) = (r*G, m*G + r*PK_recipient)` off-chain and passes only the
  ciphertext to the contract.
- The on-chain slot stores the ciphertext, not a plaintext-correlated commitment.
- ElGamal is **additively homomorphic**: `Enc(m1) + Enc(m2) = Enc(m1 + m2)`. A recipient can
  decrypt the accumulated total from multiple senders without knowing each individual amount.
- The Cadence event leak is still present at the FLOW vault level (this is inherent to Flow's
  FungibleToken interface), but the mapping from FLOW amount to recipient encrypted slot no longer
  enables per-sender amount recovery, because the EVM slot doesn't reveal individual sender
  contributions.

---

## Migration

```bash
# Install v2
npm install @openjanus/sdk@^0.2.0

# Access historical v1 source
git clone https://github.com/openjanus/sdk.git
cd sdk
git checkout v0.1.0-final
```

v1 contracts remain deployed on Flow EVM testnet at their historical addresses for reference.
They should not be used for new development.

v2 contract addresses: see [openjanus/contracts](https://github.com/openjanus/contracts)

---

## Honest Framing

We caught this before production users were affected. The v1 system was in testnet-only use
during development. The privacy limitation was identified during pre-launch analysis of a
multi-sender tipping scenario. v2 was designed, tested, and deployed to address the root cause.

---

## Technical References

- [openjanus/contracts CHANGELOG](https://github.com/openjanus/contracts/blob/main/CHANGELOG.md) — v2 deployment details
- [openjanus/contracts/packages/janus-token-v2](https://github.com/openjanus/contracts/tree/main/packages/janus-token-v2) — v2 contract source
- [openjanus/ai-tools docs](https://github.com/openjanus/ai-tools) — v2 integration documentation
