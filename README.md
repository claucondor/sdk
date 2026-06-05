# @claucondor/sdk

Multi-token privacy SDK for Flow. Version: **v0.7.4**.

Send FLOW, WFLOW, MockUSDC, or MockFT (via JanusFT generic Cadence wrapper) shielded — amounts hidden on-chain via Pedersen commitments and Groth16 proofs. No cleartext amount on calldata, events, or storage.

**v0.7.4**: Nonces for `orchestrateWrap` are now generated as cryptographically random 256-bit values via `@noble/hashes`. No localStorage state needed — works across devices and sessions with negligible (1/2^256) collision probability. If you need deterministic behaviour (tests, replay), pass `nonce` explicitly in `WrapOrchestrateInput`.

**v0.6.4**: `JanusFT` generic Cadence wrapper — production-grade, underlying-agnostic. Real cross-VM BabyJub + Groth16 ZK (no stubs). MockFT is the testnet underlying.

## Install

```bash
npm install @claucondor/sdk
```

## Quick start: the `sdk.token(id)` API

```typescript
import { sdk, deriveMemoKeyFromSignature } from '@claucondor/sdk';
import { ethers } from 'ethers';

// 1. Create a wallet (e.g. from private key)
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

// 5. Send a shielded tip to Bob (NO cleartext amount on chain)
const snapshot = await flow.latestSnapshot(wallet.address, memoKeypair.privkey);
await flow.shieldedTransfer({
  recipient: BOB_EVM_ADDR,
  amount: 2n * 10n**18n,
  memo: 'great work!',
  currentBalance: snapshot.balance,
  currentBlinding: snapshot.blinding,
}, wallet);

// 6. Bob scans for incoming tips and unwraps
const deposits = await flow.scanDeposits(BOB_EVM_ADDR);
const note = await flow.decryptNoteTo(
  deposits[0].ciphertext,
  deposits[0].ephPubkey,
  bobMemoKeypair.privkey
);
console.log('Received:', note.amount, 'memo:', note.memo);
await flow.unwrap({
  claimedAmount: note.amount,
  recipient: BOB_EVM_ADDR,
  currentBalance: note.amount,
  currentBlinding: note.blinding,
}, bobWallet);
```

## Token IDs

| ID | Variant | Contract |
|----|---------|----------|
| `flow` | native | `0x2458ae2d26797c2ffa3B4f6612Bdc4aDf22b7156` |
| `wflow` | erc20 | `0x00129E94d5340bd19d0b4ed9CDf718BB6e0A9400` |
| `mockusdc` | erc20 | `0xd45FDa099Cf67eD842eA379865AB08E18D62BAf3` |
| `mockft` | cadence-ft | `0x7599043aea001283` (JanusFT) |

All at feeBps=10 (0.1%).

## ERC20 tokens: pre-approve before wrap

```typescript
const usdc = sdk.token('mockusdc');

// Pre-approve underlying for grossAmount
const underlying = new ethers.Contract(MOCK_USDC_ADDR, ERC20_ABI, wallet);
await underlying.approve(usdc.address, 100n * 10n**6n);

// Then wrap
await usdc.wrap({ grossAmount: 100n * 10n**6n }, wallet);
```

## Reading state without signing

```typescript
// All reads use a provider — no signer required
const commitment = await sdk.token('flow').getCommitment(ALICE_EVM_ADDR);
const memoKey = await sdk.token('flow').getMemoKey(ALICE_EVM_ADDR);
const bps = await sdk.token('flow').feeBps(); // 10 = 0.1%
const net = await sdk.token('flow').computeNet(5n * 10n**18n);
```

## MemoKey: the persistence contract

The MemoKey is a BabyJub keypair derived deterministically from a wallet signature. Publish the pubkey once; keep the privkey in memory only.

```typescript
import { deriveMemoKeyFromSignature, MEMO_KEY_CONTEXT } from '@claucondor/sdk';

// On any device with the same wallet, you get the same keypair:
const sig = await wallet.signMessage('OpenJanus MemoKey v1');
const keypair = await deriveMemoKeyFromSignature(ethers.getBytes(sig));
// keypair.pubkey  → publish on-chain
// keypair.privkey → decrypt snapshots + notes (never persisted)
```

## Snapshot recovery

If you lose local state, reconstruct from on-chain events:

```typescript
const snapshot = await sdk.token('flow').latestSnapshot(MY_EVM_ADDR, memoPrivKey);
console.log('Recovered balance:', snapshot.balance);
console.log('Recovered blinding:', snapshot.blinding);
// timestampMs is ALWAYS in milliseconds
console.log('As of:', new Date(snapshot.timestampMs).toISOString());
```

## Advanced: orchestration layer (for custom adapters)

The SDK exposes its internal proof-building pipeline for power users:

```typescript
import { orchestrateWrap, orchestrateShieldedTransfer, orchestrateUnwrap } from '@claucondor/sdk';

// orchestrateWrap returns: { netAmount, fee, txCommit, amountProof, encryptedSnapshot, ... }
// orchestrateShieldedTransfer returns: { publicInputs, proof, encryptedSnapshot, encryptedNoteTo, ... }
// orchestrateUnwrap returns: { txCommit, amountProof, transferPublicInputs, transferProof, ... }
```

## Architecture

See `docs/ARCHITECTURE.md` for the full 4-layer model.

## Privacy properties

- **wrap/unwrap**: amount VISIBLE at boundary (by design — auditable custody accounting)
- **shieldedTransfer**: amount HIDDEN on calldata, events, AND storage
- **Commitment opacity**: 128-bit Pedersen blinding — brute-force infeasible
- **Forward secrecy**: fresh ephemeral per shieldedTransfer — two sends to same recipient are unlinkable
- **Note encryption**: BabyJub ECIES + AES-256-GCM

## License

MIT
