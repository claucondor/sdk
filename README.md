# @claucondor/sdk

Multi-token privacy SDK for Flow. Version: **v0.8.0-alpha.1**.

Send FLOW, MockUSDC, or MockFT (via JanusFT generic Cadence wrapper) shielded — amounts hidden on-chain via Pedersen commitments and Groth16 proofs. No cleartext amount on calldata, events, or storage.

**v0.8.0-alpha.1**: Protocol overhaul. `shieldedTransfer` is now 6-arg (sender snapshot removed from calldata). `scan/` replaced by `ShieldedInboxClient` (inbox drain) + `ShieldedCheckpointClient` (state recovery). New `cadence/` module with atomic transfer+checkpoint templates. See CHANGELOG for full details.

## Install

```bash
npm install @claucondor/sdk
```

## Quick start: the `sdk.token(id)` API

```typescript
import { sdk, deriveMemoKeyFromSignature, ShieldedInboxClient, ShieldedCheckpointClient } from '@claucondor/sdk';
import { ethers } from 'ethers';

// 1. Create a wallet
const wallet = new ethers.Wallet(process.env.PRIVKEY!, provider);

// 2. Derive your persistent MemoKey (one signature → deterministic keypair)
const sig = await wallet.signMessage('OpenJanus MemoKey v1');
const memoKeypair = await deriveMemoKeyFromSignature(ethers.getBytes(sig));

// 3. Publish your MemoKey (once — idempotent)
const flow = sdk.token('flow');
await flow.publishMemoKey(memoKeypair, wallet);

// 4. Wrap FLOW into your shielded slot
const wrapResult = await flow.wrap({ grossAmount: 5n * 10n**18n }, wallet);
console.log('Wrapped, net:', wrapResult.netAmount); // 4.995 FLOW (0.1% fee)

// 5. Recover balance from checkpoint (or use last known state)
const checkpoint = new ShieldedCheckpointClient();
const snapshot = await checkpoint.readAndDecrypt(wallet, memoKeypair.privkey);
// snapshot.balance, snapshot.blinding

// 6. Send a shielded transfer to Bob
const { txHash, checkpointPayload, newBalance, newBlinding } = await flow.shieldedTransfer({
  recipient: BOB_EVM_ADDR,
  amount: 2n * 10n**18n,
  memo: 'great work!',
  currentBalance: snapshot!.balance,
  currentBlinding: snapshot!.blinding,
}, wallet);

// 7. Update your sender checkpoint (persist new balance on-chain)
await checkpoint.update(checkpointPayload!, 0n, wallet);

// 8. Bob drains his inbox and decrypts incoming notes
const inbox = new ShieldedInboxClient();
const { decrypted } = await inbox.drainAndDecrypt(bobWallet, bobMemoKeypair.privkey);
for (const { content } of decrypted) {
  console.log('Received:', content.amount, 'memo:', content.memo);
}
```

## Token IDs

Testnet (Flow EVM chainId 545 + Flow Cadence testnet). Single source of truth: `src/network/contracts.ts`.

| ID | Variant | Decimals | Proxy / Cadence deployer |
|----|---------|----------|--------------------------|
| `flow` | native EVM | 18 | `0xA64340C1d356835A2450306Ffd290Ed52c001Ad3` |
| `mockusdc` | EVM ERC20 | 6 | `0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d` |
| `mockft` | Cadence FT | 8 | `0x4b6bc58bc8bf5dcc` (JanusFT) |

All at `feeBps=10` (0.1%).

### Shared infra (v0.8 testnet)

| Component | Address |
|---|---|
| `ShieldedInbox` (EVM) | `0x0C787AAcbA9a116EdA4ec05Be41D8474D470bfC6` |
| `ShieldedCheckpoint` (EVM) | `0xbF8dbE133FC1319570dBe43E32BFD9a6D64E1E76` |
| `MemoKeyRegistry` (EVM) | `0x361bD4d037838A3a9c5408AE465d36077800ee6c` |
| `ConfidentialTransferVerifier` | `0x38e69fE7Ba7c2C586d64DFFc14742641A675666c` |
| `AmountDiscloseVerifier` | `0xf7B634D41259D0613345633eE1CD193A030A6329` |
| Cadence deployer | `0x4b6bc58bc8bf5dcc` |
| Cadence deployer COA (EVM) | `0x0000000000000000000000020885d7ad3582356a` |

## v0.8 protocol architecture

```
shieldedTransfer (6-arg)
  ├── token.deposit(recipient, ciphertext, ephX, ephY)  ← called internally by token contract
  └── (returns checkpointPayload)

checkpointPayload → ShieldedCheckpoint.update()  ← caller submits separately
                                                   OR use combinedShieldedTransferWithCheckpoint.cdc
```

**State recovery (v0.8):**

```typescript
// No more event scanning. One read per session:
const cp = await checkpointClient.readAndDecrypt(wallet, memoPrivKey);
// cp.balance = verified sender balance
// cp.blinding = Pedersen blinding factor

// Then drain any pending inbox notes (incoming transfers since last checkpoint):
const { decrypted } = await inboxClient.drainAndDecrypt(wallet, memoPrivKey);
const incomingTotal = decrypted.reduce((s, { content }) => s + content.amount, 0n);
const trueBalance = cp.balance + incomingTotal;
```

## ERC20 tokens: pre-approve before wrap

```typescript
const usdc = sdk.token('mockusdc');
// Pre-approve underlying for grossAmount
const underlying = new ethers.Contract(MOCK_USDC_ADDR, ERC20_ABI, wallet);
await underlying.approve(usdc.address, 100n * 10n**6n);
await usdc.wrap({ grossAmount: 100n * 10n**6n }, wallet);
```

## Cadence-native operations (JanusFT / Flow wallet users)

```typescript
import { cadenceTx } from '@claucondor/sdk/cadence';
import * as fcl from '@onflow/fcl';

// First-time setup (idempotent):
await fcl.mutate({ cadence: cadenceTx.installInboxAndCheckpoint(), args: () => [] });

// Atomic shieldedTransfer + checkpoint update in ONE Cadence tx:
const JANUS_FLOW_PROXY = "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3";
await fcl.mutate({
  cadence: cadenceTx.combinedShieldedTransferWithCheckpoint(JANUS_FLOW_PROXY),
  args: (arg, t) => [
    arg(recipientEVMAddress, t.Address),
    arg(publicInputs.map(String), t.Array(t.UInt256)),
    arg(proof.map(String), t.Array(t.UInt256)),
    arg(Array.from(encryptedNoteTo).map(String), t.Array(t.UInt8)),
    arg(ephPubkeyToX.toString(), t.UInt256),
    arg(ephPubkeyToY.toString(), t.UInt256),
    arg(Array.from(encryptedSnapshot).map(String), t.Array(t.UInt8)),
    arg(ephPubkeyX.toString(), t.UInt256),
    arg(ephPubkeyY.toString(), t.UInt256),
    arg(String(lastConsumedNoteIndex), t.UInt64),
  ],
});
```

## Reading state without signing

```typescript
// All reads use a provider — no signer required
const commitment = await sdk.token('flow').getCommitment(ALICE_EVM_ADDR);
const memoKey = await sdk.token('flow').getMemoKey(ALICE_EVM_ADDR);
const bps = await sdk.token('flow').feeBps(); // 10 = 0.1%
const net = await sdk.token('flow').computeNet(5n * 10n**18n);

// Checkpoint metadata (public — no signer):
const cp = new ShieldedCheckpointClient();
const meta = await cp.metadata(ALICE_EVM_ADDR);
// { version, lastConsumedNoteIndex, lastUpdatedBlock, hasCheckpoint }

// Inbox pending count (public — no signer):
const inbox = new ShieldedInboxClient();
const pending = await inbox.count(ALICE_EVM_ADDR);
```

## MemoKey: the persistence contract

The MemoKey is a BabyJub keypair derived deterministically from a wallet signature. Publish the pubkey once; keep the privkey in memory only.

```typescript
import { deriveMemoKeyFromSignature } from '@claucondor/sdk';

// On any device with the same wallet, you get the same keypair:
const sig = await wallet.signMessage('OpenJanus MemoKey v1');
const keypair = await deriveMemoKeyFromSignature(ethers.getBytes(sig));
// keypair.pubkey  → publish on-chain once
// keypair.privkey → decrypt checkpoints + inbox notes (never persisted)
```

## Advanced: orchestration layer (for custom adapters)

```typescript
import { orchestrateShieldedTransfer } from '@claucondor/sdk';

// Returns txParams (for shieldedTransfer calldata) + checkpointPayload (for ShieldedCheckpoint.update)
const orch = await orchestrateShieldedTransfer({
  currentBalance, currentBlinding, transferAmount,
  senderMemoKeypair, recipientMemoKey, memo,
});
// orch.txParams.publicInputs  — 6 inputs for the transfer proof
// orch.txParams.proof         — 8-element Groth16 proof
// orch.txParams.encryptedNoteTo — ECIES ciphertext for recipient
// orch.checkpointPayload       — pass to ShieldedCheckpoint.update()
// orch.newBalance, orch.newBlinding — local state update
```

## Privacy properties

- **wrap/unwrap**: amount VISIBLE at boundary (by design — auditable custody accounting)
- **shieldedTransfer**: amount HIDDEN on calldata, events, AND storage
- **Commitment opacity**: 128-bit Pedersen blinding — brute-force infeasible
- **Forward secrecy**: fresh ephemeral per shieldedTransfer — two sends to same recipient are unlinkable
- **Note encryption**: BabyJub ECIES + AES-256-GCM
- **Checkpoint privacy**: read() scoped to msg.sender — blob not exposed to public callers

## Running integration & E2E tests

The SDK ships unit tests by default. Integration and E2E tests against the live testnet v0.8 stack are gated:

```bash
# Unit only (default)
npm test

# Integration tests against testnet v0.8 stack
RUN_INTEGRATION=1 npm run test:integration

# E2E tests using only SDK public API
RUN_E2E=1 npm run test:e2e

# All tests (unit + integration + e2e)
RUN_INTEGRATION=1 RUN_E2E=1 npm run test:all
```

The integration suites use the deployer EOA at `0xFc47B35f79d26A060B652E112c53d7c6057d05FF` as the primary funded account — it funds fresh random EOA wallets used as test senders, avoiding commitment-state conflicts between runs.

Tests cover:

- **ShieldedInboxClient**: `count`, `peek`, `drainBatch`, `drainAndDecrypt` — full wrap → transfer → drain cycle
- **ShieldedCheckpointClient**: `encryptAndUpdate`, `readAndDecrypt`, `metadata`, cursor rewind, `SnapshotTooLarge` revert path
- **MemoKeyRegistry** (via `JanusFlowAdapter`): `publishMemoKey`, `getMemoKey`, `rotateMemoKey`
- **JanusFlowAdapter**: wrap → shieldedTransfer → checkpoint → drainAndDecrypt → unwrap using SDK orchestration layer
- **JanusERC20Adapter**: mint → approve → wrap → shieldedTransfer → drain → decode → unwrap for MockUSDC
- **E2E FLOW lifecycle**: `sdk.token('flow').wrap()` → blinding recovery from `WrapWithSnapshot` event → `shieldedTransfer` → inbox drain → `unwrap`
- **E2E mUSDC lifecycle**: same pattern for ERC20 tokens via `sdk.token('mockusdc')`
- **E2E multi-token**: one sender holds both FLOW and mUSDC shielded; sends FLOW to Bob, mUSDC to Carol; isolated inboxes verified

## License

MIT
