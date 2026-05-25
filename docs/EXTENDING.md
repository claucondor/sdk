# Extending @openjanus/sdk

This guide explains how to add new modules to the SDK without modifying
any existing module. The architecture is designed so that adding a module
is purely additive — zero refactoring of existing code.

---

## Architecture principle

Each module is self-contained:

```
src/
├── <module>/
│   ├── types.ts     # Module-specific types (no runtime code)
│   ├── <module>.ts  # Implementation
│   └── index.ts     # Public surface for this module
```

Modules only depend downward:

```
tokens/   → crypto/ → primitives/
network/  → (standalone)
utils/    → (standalone)
types/    → (standalone)
```

A new module at the same level as `crypto/` can import from `primitives/` and `utils/`.
A new module at the same level as `tokens/` can import from `crypto/`, `primitives/`, and `utils/`.

**No circular dependencies are permitted.**

---

## Step-by-step: adding HekateMixer

HekateMixer is a Tornado-style mixer. Here is how to add it.

### 1. Create the module directory

```
src/modules/mixer/
├── types.ts        # MixerNote, MixerDeposit, MixerWithdraw, etc.
├── mixer.ts        # HekateMixer class
└── index.ts        # Public surface
```

Note: Place in `src/modules/` (a new top-level directory) to signal it is
an optional, higher-level protocol rather than a core primitive.

### 2. Write types.ts

```typescript
// src/modules/mixer/types.ts

export interface MixerNote {
  nullifier: bigint;    // Secret nullifier (must be stored by user)
  secret: bigint;       // Secret randomness
  amount: bigint;       // Fixed denomination
  leafIndex: number;    // Position in Merkle tree
}

export interface MixerDepositInput {
  amount: bigint;
  denominationIndex: number; // 0=1FLOW, 1=10FLOW, 2=100FLOW
}

export interface MixerWithdrawInput {
  note: MixerNote;
  recipient: string;          // EVM recipient address
  relayer?: string;           // Optional relayer address
  relayerFee?: bigint;        // Fee to pay relayer
  merkleProofPath: string;    // Path to Merkle proof JSON
}
```

### 3. Write mixer.ts

```typescript
// src/modules/mixer/mixer.ts

import { computeCommitment, generateBlinding } from "../../crypto/commitment";
import { buildTransferProof } from "../../crypto/transfer-proof";
import { createEvmWallet } from "../../network/flow-client";
// ... implement HekateMixer class
```

### 4. Write index.ts

```typescript
// src/modules/mixer/index.ts

export { HekateMixer } from "./mixer";
export type { MixerNote, MixerDepositInput, MixerWithdrawInput } from "./types";
```

### 5. Register in src/index.ts

Add two lines to `src/index.ts`:

```typescript
// At the end of src/index.ts:
export * as mixer from "./modules/mixer";
```

This makes the mixer available as:
```typescript
import { mixer } from "@openjanus/sdk";
const hekate = new mixer.HekateMixer({ network: "testnet" });
```

Or as a direct import:
```typescript
import { HekateMixer } from "@openjanus/sdk/modules/mixer";
```

### 6. Register in tsup.config.ts

Add an entry point:
```typescript
entry: {
  // ... existing entries ...
  "modules/mixer/index": "src/modules/mixer/index.ts",
},
```

### 7. Add integration test

```
tests/integration/mixer.integration.test.ts
```

```typescript
// tests/integration/mixer.integration.test.ts

import { describe, it, expect } from "vitest";
import { HekateMixer } from "../../src/modules/mixer";

const SKIP = !process.env["RUN_INTEGRATION"];

describe.skipIf(SKIP)("HekateMixer integration", () => {
  it("I1: deposit creates a valid note", async () => {
    // ...
  });
  it("I2: withdraw with valid note succeeds", async () => {
    // ...
  });
});
```

---

## Planned future modules

| Module | Path | Status |
|--------|------|--------|
| HekateMixer (Tornado-style) | `src/modules/mixer/` | Planned (L8) |
| StealthAddress | `src/modules/stealth/` | Planned (L9) |
| MerkleTree (anonymous ownership) | `src/modules/merkle/` | Planned (L9) |
| Schnorr / BLS signatures | `src/signatures/` | Planned (L10) |
| BeaconBound ZK (Flow VRF) | `src/modules/beacon/` | Research |

---

## Naming conventions

| Item | Convention | Example |
|------|-----------|---------|
| Module directory | kebab-case | `stealth-address/` |
| Class names | PascalCase | `HekateMixer`, `StealthAddress` |
| Constants | SCREAMING_SNAKE | `MIXER_CONTRACT_ADDRESS` |
| Deployment objects | `<MODULE>_TESTNET` | `MIXER_TESTNET` |
| Cadence TX strings | `TX_<ACTION>` | `TX_DEPOSIT` |
| FCL scripts | `SCRIPT_<ACTION>` | `SCRIPT_GET_NOTE_STATUS` |

---

## Testing requirements for new modules

Every new module must include:
1. At least one **unit test** file in `tests/unit/<module>.unit.test.ts`
2. At least one **integration test** in `tests/integration/<module>.integration.test.ts`
   - Integration tests MUST be gated by `process.env["RUN_INTEGRATION"]`
   - Integration tests MUST use real testnet contracts / real TX hashes
3. A matching example in `examples/<use-case>.ts`

---

## No refactoring rule

If adding a new module requires modifying any existing file other than:
- `src/index.ts` (one new export line)
- `tsup.config.ts` (one new entry point)

Then the architecture is wrong. File a design issue instead.
