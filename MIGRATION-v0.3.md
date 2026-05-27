# Migration: @openjanus/sdk v0.2.x → v0.3.0

v0.3.0 is a **breaking** major release. The on-chain contracts are new
addresses with a new ABI and a new commitment scheme — so apps cannot
hot-swap by bumping the npm version alone; the wrap / transfer / unwrap
flows must be rewritten against the generic shielded API documented below.

## Why we shipped a breaking release

The v0.2.x JanusToken (ElGamal accumulator) had two real privacy
regressions that could not be patched without an ABI change:

1. **Cleartext `transferUnits` on every shielded transfer** — the on-chain
   call signature accepted a small-int amount in WHOLE FLOW and updated a
   public `locked[user]` ledger by that amount. Both `transferUnits` (in
   calldata) and the `locked` delta (in storage) leaked the transferred
   amount to any observer.
2. **Vuln 014 (SCALE unit mismatch)** in unwrap. The v0.2.1 patch fixed
   the unit mismatch but kept the leaky `locked[user]` book-keeping — the
   amount was still observable.

v0.3 moves to a **fully shielded Pedersen-commit** scheme. Per-account
storage is now an opaque BabyJubJub point (`commitments[user]`), updated
homomorphically. The only cleartext aggregate is `totalLocked` — kept
**by design** so external observers can audit the size of the shielded
pool. Wrap and unwrap remain (intentionally) cleartext-amount at the
boundary; everything inside the shielded pool stays hidden.

References:
- audits-kb vulnerability 014 — SCALE unit mismatch (v0.2.1 root cause).
- lab `v03-smoke.mjs` privacy validation — empirical reproduction of the
  v0.2 leak and v0.3 hidden behaviour.

## Address changes

| Concept                       | v0.2 / v0.2.1                                  | v0.3                                                                |
|-------------------------------|------------------------------------------------|---------------------------------------------------------------------|
| JanusToken / JanusFlow EVM    | `0x025efe7e89acdb8F315C804BE7245F348AA9c538`   | `0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078`                        |
| JanusFlow EVM impl            | (UUPS hidden)                                  | `0x9321dF5884021D7E19Ad0EB5F582f8E2A70236eC`                        |
| Amount-binding verifier       | EncryptConsistencyVerifier `0x0C1e7310…3B1e`   | AmountDiscloseVerifier `0xD0ED3936530258C278f5357C1dB709ad34768352` |
| Transfer / decrypt verifier   | DecryptOpenVerifier `0x1c248dA9…6Dbc`          | ConfidentialTransferVerifier `0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B` |
| BabyJub.sol                   | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870`   | (unchanged)                                                         |
| Cadence router                | `0xbef3c77681c15397`                           | `0x5dcbeb41055ec57e`                                                |
| Owner (admin COA, EVM)        | `0x0000000000000000000000022f6b30af48a94787`   | (unchanged)                                                         |

Pre-ceremony / pre-SCALE-fix addresses (`0xb12E…a499`, `0xC715b3…638b`,
the v1 Cadence zombie `0x28fef3d1d6a12800`) remain dead — never use them.

## API changes

### Removed (v0.2 ElGamal)

The following symbols are GONE in v0.3 — replace each with the v0.3 equivalent
in the next table:

```ts
// v0.2 exports — REMOVED
JanusToken.registerPubkey(pk)
JanusToken.wrap(to, flowUnits, nonce, encryptProof)
JanusToken.confidentialTransfer(to, transferUnits, nonce, encryptProof)
JanusToken.unwrap(recipient, claimedUnits, decryptProof)
JanusToken.encryptTo(...)            // already deprecated in 0.2.1
JanusToken.decryptAndUnwrap(...)     // already deprecated in 0.2.1

JanusFlow.registerPubkey(pk, authz)
JanusFlow.wrapAndEncrypt(amount, recipient, encryptProof, authz)
JanusFlow.confidentialTransfer(recipient, encryptProof, authz)
JanusFlow.decryptAndUnwrap(amount, to, decryptProof, authz)

buildEncryptProof(...)               // ElGamal encrypt-consistency proof
buildDecryptProof(...)               // ElGamal decrypt-open proof
buildTransferProof(...)              // pre-v0.2 Pedersen transfer proof

Ciphertext, EncryptedSlot, ElGamalKeypair, ElGamalCiphertext  // ElGamal types
ENCRYPT_CONSISTENCY_VERIFIER, DECRYPT_OPEN_VERIFIER, JANUS_TOKEN_TESTNET,
JANUS_TOKEN_EVM, ENCRYPT_VERIFIER_EVM, DECRYPT_VERIFIER_EVM
```

### Replaced (v0.3 generic shielded API)

```ts
// New top-level API
import {
  JanusFlow,                          // concrete native-FLOW class
  JanusToken,                         // abstract base for future tokens (ERC-20, …)
  JanusFlowCadence,                   // Cadence router read-only helper
  buildAmountDiscloseProof,           // wrap / unwrap boundary proof
  buildShieldedTransferProof,         // fully shielded sender → recipient proof
  computeCommitment,                  // Pedersen helper
  generateBlinding,                   // 128-bit random blinding factor
  flowToWei, weiToFlow, FLOW_SCALE,   // unit helpers
  randomBabyJubScalar,                // subgroup-safe random scalar
  JANUS_FLOW_TESTNET,                 // canonical TokenOptions for testnet
  JANUS_FLOW_EVM_ADDRESS,
  AMOUNT_DISCLOSE_VERIFIER,
  CONFIDENTIAL_TRANSFER_VERIFIER,
} from "@openjanus/sdk";
```

Migration recipes:

```ts
// v0.2: wrapAndEncrypt
await sdk.wrapAndEncrypt(amountUFix64, recipient, encryptProof, authz);

// v0.3: wrap (caller is the depositor; recipient is implicit = caller)
const wrapProof = await buildAmountDiscloseProof({ amount: amountWei, blinding });
await flow.wrap({
  amountWei,
  txCommit:   wrapProof.txCommit,
  amountProof: wrapProof.proof,
});
```

```ts
// v0.2: confidentialTransfer
await sdk.confidentialTransfer(recipient, encryptProof, authz);

// v0.3: shieldedTransfer (amount HIDDEN end-to-end)
const tProof = await buildShieldedTransferProof({
  oldBalance, oldBlinding, transferAmount, transferBlinding, newBlinding,
});
await flow.shieldedTransfer({
  to: recipient,
  publicInputs: tProof.publicInputs,
  proof:        tProof.proof,
});
```

```ts
// v0.2: decryptAndUnwrap
await sdk.decryptAndUnwrap(amountUFix64, to, decryptProof, authz);

// v0.3: unwrap (needs BOTH amount-disclose AND transfer proofs)
const amtProof = await buildAmountDiscloseProof({
  amount: claimedAmountWei,
  blinding: transferBlinding,
});
const tProof = await buildShieldedTransferProof({
  oldBalance, oldBlinding, transferAmount: claimedAmountWei,
  transferBlinding, newBlinding,
});
await flow.unwrap({
  claimedAmountWei,
  recipient,
  txCommit:             amtProof.txCommit,
  amountProof:          amtProof.proof,
  transferPublicInputs: tProof.publicInputs,
  transferProof:        tProof.proof,
});
```

### Storage model changes

v0.2 stored an ElGamal ciphertext `(C1, C2)` per account plus a registered
BabyJubJub pubkey. v0.3 stores a single `Point` commitment per account —
**no pubkey registration is needed**. Pubkey rotation / registration calls
are simply gone in v0.3.

```ts
// v0.2
const slot = await sdk.getSlot(address);      // ciphertext
const pk   = await sdk.getPubkey(address);    // pubkey

// v0.3
const commit = await flow.balanceOfCommitment(address);   // Pedersen Point
const total  = await flow.totalSupplyCommitment();        // homomorphic sum
const pool   = await flow.totalLocked();                  // visible aggregate
```

### Cadence transaction templates

The exported `TX_*` template strings are renamed and updated to import from
the v0.3 router (`0x5dcbeb41055ec57e`):

| v0.2 (router-shaped)            | v0.3                            |
|---------------------------------|---------------------------------|
| `TX_REGISTER_PUBKEY`            | removed (no pubkey in v0.3)     |
| `TX_WRAP_AND_ENCRYPT`           | `TX_WRAP`                       |
| `TX_CONFIDENTIAL_TRANSFER`      | `TX_SHIELDED_TRANSFER`          |
| `TX_DECRYPT_AND_UNWRAP`         | `TX_UNWRAP`                     |
| `SCRIPT_GET_SLOT`               | `flow.balanceOfCommitment(addr)` on EVM |
| `SCRIPT_GET_PUBKEY`             | removed                         |
| `SCRIPT_IS_PAUSED`              | (unchanged)                     |
| `SCRIPT_GET_ACTIVE_IMPL_VERSION`| (unchanged)                     |
| –                               | `SCRIPT_GET_TOTAL_LOCKED` (new) |
| –                               | `SCRIPT_GET_EVM_TARGET` (new)   |

## App responsibilities (new in v0.3)

Because the chain no longer stores cleartext balances OR ciphertexts that the
user can decrypt with a private key, every app MUST persist (locally on the
user's device) the cleartext side of every commitment it produces:

- Each `wrap` produces a fresh `blinding`. Store `(amount, blinding)` paired
  with the resulting commitment.
- Each `shieldedTransfer` produces a `newBlinding` for the sender's residual
  balance. Store `(newBalance, newBlinding)` and discard the old pair.
- Recipients of a `shieldedTransfer` MUST be told the
  `(transferAmount, transferBlinding)` out-of-band — they cannot reconstruct
  them from on-chain state alone. Common patterns: encrypted messaging
  channel, push notification, off-chain receipt. (Future SDK releases may
  ship a built-in recipient-discovery helper.)

This is a real product responsibility — the v0.2 ElGamal accumulator hid
this from apps by encrypting to the recipient's registered pubkey, but
that's what leaked the amounts.

## Bundled artifacts

The v0.3 SDK ships the production Groth16 artifacts in `circuits/v0.3/`:

- `amount_disclose.wasm` / `amount_disclose_final.zkey` / `amount_disclose_vkey.json`
- `confidential_transfer.wasm` / `confidential_transfer_final.zkey` / `confidential_transfer_vkey.json`
- `AmountDiscloseVerifier.sol` / `ConfidentialTransferVerifier.sol` (for reference / verification)
- `CEREMONY-RECORD.json` (full sha256 provenance chain)

Old `circuits/build/`, `circuits/setup/`, `circuits/source/` (v0.2 ElGamal
artifacts) are removed in v0.3. The npm tarball no longer carries the dead weight.

## Going further

- `README.md` — quickstart + full privacy property table.
- `circuits/v0.3/CEREMONY-RECORD.json` — trusted-setup provenance.
- Lab `v03-smoke.mjs` (in `cadence-crypto-lab`) — empirical privacy validation.
- audits-kb vulnerability 014 — historical context on the SCALE unit bug.
