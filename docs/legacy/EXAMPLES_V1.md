# Legacy v1 Examples (Pedersen-hash JanusToken/JanusFlow)

> **These examples are archived.** They used the v1 Pedersen-hash based JanusToken/JanusFlow.
> v1 was deprecated in 0.2.0 due to a privacy limitation — see [why-v1-was-deprecated.md](../why-v1-was-deprecated.md).
>
> For current development, use `@openjanus/sdk@^0.2.0` and the v2 (ElGamal-on-BabyJub) stack.
> Historical v1 source: `git checkout v0.1.0-final`

---

## basic-transfer.ts (v1)

```typescript
/**
 * examples/basic-transfer.ts (v1 — archived)
 *
 * Demonstrates the complete JanusFlow v1 lifecycle:
 *   Alice wraps 10 FLOW → transfers 3 to Bob → Bob unwraps 3 FLOW
 *
 * Reference TX hashes from successful v1.1.0 E2E test (2026-05-25):
 *   Alice wrap:         a08a6e4106ae6e425e5daa2c97e6693424cc5ea620a2a83b523d82eecf41d19e
 *   Alice→Bob transfer: b18e4517c59344fdc88d5527321f83fa2fb26df47b43a6c0866845d013f41399
 *   Bob unwrap:         5938fd26af0ad510a04d4be299e13734174ffe2b415f2f687e2934e152fee8a7
 *
 * Deployed contracts (v1, historical):
 *   JanusToken.sol: 0x53F49881A1132FF4F674D2c015e35D5B07Fa1F4A
 *   JanusFlow.cdc: 0x28fef3d1d6a12800 (contract: JanusFlow v1.1.0)
 */

import { JanusFlow } from "@openjanus/sdk/tokens";  // v0.1.x only
import { computeCommitment, generateBlinding } from "@openjanus/sdk";

const sdk = new JanusFlow({ network: "testnet" });
await sdk.configure();

// Alice wraps 10 FLOW
const aliceBlinding = generateBlinding();
const aliceCommitment = await computeCommitment(10n, aliceBlinding);
const { txId: wrapTx } = await sdk.wrap("10.0", 10n, aliceBlinding, aliceAuthz);

// Alice transfers 3 FLOW to Bob
const { txId: transferTx } = await sdk.confidentialTransfer(
  BOB_CADENCE_ADDRESS,
  {
    oldBalance: 10n,
    oldBlinding: aliceBlinding,
    transferAmount: 3n,
    transferBlinding: generateBlinding(),
    newBlinding: generateBlinding(),
    wasmPath: "/path/to/confidentialTransfer.wasm",
    zkeyPath: "/path/to/confidentialTransfer_final.zkey",
  },
  aliceAuthz
);

// Bob unwraps 3 FLOW
const { txId: unwrapTx } = await sdk.unwrap("3.0", 3n, txBlinding, BOB_CADENCE_ADDRESS, bobAuthz);
```

---

## multi-wrap.ts (v1)

```typescript
/**
 * examples/multi-wrap.ts (v1 — archived)
 *
 * Demonstrates homomorphic accumulation at Charlie's slot:
 *   Alice wraps 50 FLOW → transfers 10 to Charlie
 *   Bob wraps 30 FLOW → transfers 5 to Charlie
 *   Charlie unwraps 15 FLOW
 *
 * Reference TX hashes from successful v1.1.0 E2E test:
 *   Alice→Charlie:  21665c5f726538c13f3e722c2a2d66c42ac7c6cbee40705c159a26ab63393b61
 *   Bob→Charlie:    630804253f8b762f1e879caff5f28525a7251edb4954924a07ce9f19726e6c6d
 *   Charlie unwrap: 7db94ebd29903e556bc741b93b4707c715a68cfe5b5569ffce3b416cb92a6d34
 *
 * NOTE: circomlib Pedersen is a hash function, not a two-generator EC commitment.
 * JanusToken v1 accumulates commitment POINTS additively at the recipient slot.
 * The ZK circuit proves balance conservation at transfer time.
 *
 * IMPORTANT: This example demonstrates a pattern that was SUPERSEDED by v2.
 * In multi-sender scenarios, v1 leaks per-sender amounts via Cadence events.
 * See docs/why-v1-was-deprecated.md for details.
 */

// Alice wraps 50 FLOW, transfers 10 to Charlie
await sdk.wrap("50.0", 50n, r_alice, aliceAuthz);
await sdk.confidentialTransfer(CHARLIE, { oldBalance: 50n, transferAmount: 10n, ... }, aliceAuthz);

// Bob wraps 30 FLOW, transfers 5 to Charlie
await sdk.wrap("30.0", 30n, r_bob, bobAuthz);
await sdk.confidentialTransfer(CHARLIE, { oldBalance: 30n, transferAmount: 5n, ... }, bobAuthz);

// Charlie unwraps 15 FLOW (total from both senders)
await sdk.unwrap("15.0", 15n, r_total, CHARLIE_ADDR, charlieAuthz);
```
