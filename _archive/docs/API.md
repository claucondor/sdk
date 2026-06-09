# @claucondor/sdk — Public API Reference

## Import patterns

```typescript
// Token operations (most apps only need this)
import { JanusToken, JanusFlow } from "@claucondor/sdk";

// Crypto operations (advanced users)
import { buildTransferProof, computeCommitment, generateBlinding } from "@claucondor/sdk";

// Network helpers
import { createEvmWallet, NETWORK_CONFIG } from "@claucondor/sdk";

// Primitive modules (power users, extension authors)
import { primitives, utils } from "@claucondor/sdk";

// Types only
import type { CommitmentXY, ProofUint256, FlowNetwork } from "@claucondor/sdk";

// Direct module imports (tree-shakeable)
import { JanusToken } from "@claucondor/sdk/tokens";
import { computeCommitment } from "@claucondor/sdk/crypto";
import { isOnCurveLocal } from "@claucondor/sdk/primitives";
```

---

## JanusToken

EVM SDK for JanusToken (NATIVE mode and WRAPPER mode).

```typescript
class JanusToken {
  constructor(opts: TokenOptions);

  // Connection
  connect(): Promise<this>;                          // Read-only
  connectWithSigner(signer: Signer): Promise<this>;  // With signing

  // Properties
  get address(): string;

  // View
  balanceOfCommitment(account: string): Promise<CommitmentXY>;
  totalSupplyCommitment(): Promise<CommitmentXY>;
  isWrapperMode(): Promise<boolean>;

  // NATIVE mode (owner only)
  mintXY(to: string, cx: bigint, cy: bigint): Promise<TransactionReceipt>;
  mint(to: string, amount: bigint, blinding: bigint): Promise<{receipt, commit}>;
  burnXY(from: string, cx: bigint, cy: bigint): Promise<TransactionReceipt>;

  // WRAPPER mode
  wrap(amount: bigint, commitment: CommitmentXY): Promise<TransactionReceipt>;
  unwrap(from: string, amount: bigint, commitment: CommitmentXY): Promise<TransactionReceipt>;

  // All modes
  confidentialTransfer(to, publicInputs, proof): Promise<TransactionReceipt>;
  proveAndTransfer(to, proofInput): Promise<{receipt, proofResult}>;
}

const JANUS_TOKEN_TESTNET: TokenOptions; // 0x53F49881A1132FF4F674D2c015e35D5B07Fa1F4A
```

---

## JanusFlow

Cadence-native FLOW wrapper SDK — router/impl pattern (v0.2.0-router).
Canonical address: `0xbef3c77681c15397`. DEPRECATED zombie: `0x28fef3d1d6a12800` (DO NOT USE).

```typescript
class JanusFlow {
  constructor(opts: { network: FlowNetwork });
  configure(): Promise<this>;

  // Read
  getSlot(userAddress: string): Promise<Ciphertext>;
  getPubkey(userAddress: string): Promise<Point>;
  isPaused(): Promise<boolean>;
  getActiveImplVersion(): Promise<string>;

  // Write (require FCL authz)
  registerPubkey(pk: Point, authz): Promise<{txId}>;
  wrapAndEncrypt(amount: string, recipient: string, proofResult: EncryptProofResult, authz): Promise<{txId, ciphertext}>;
  confidentialTransfer(recipient: string, proofResult: EncryptProofResult, authz): Promise<{txId, ciphertext}>;
  decryptAndUnwrap(amount: string, to: string, proofResult: DecryptProofResult, authz): Promise<{txId, amount}>;

  // Admin (require AdminResource at /storage/janusFlowAdmin)
  pause(authz): Promise<{txId}>;
  unpause(authz): Promise<{txId}>;
  finalizeImplSwap(authz): Promise<{txId}>;
  cancelImplSwap(authz): Promise<{txId}>;
}

const JANUS_FLOW_CADENCE_ADDRESS = "0xbef3c77681c15397"; // canonical router
const JANUS_FLOW_CADENCE_ADDRESS_LEGACY = "0x28fef3d1d6a12800"; // @deprecated zombie
const JANUS_FLOW_VERSION = "0.2.0-router";
```

---

## Crypto operations

### computeCommitment

```typescript
computeCommitment(value: bigint, blinding: bigint): Promise<CommitmentXY>
```

Compute a Pedersen commitment C = Pedersen(value, blinding) on BabyJubJub.

- `value` must be in [0, 2^64)
- `blinding` must be in [0, 2^128) — generate with `generateBlinding()`
- Throws `RangeError` on out-of-range inputs

### buildTransferProof

```typescript
buildTransferProof(input: TransferProofInput): Promise<TransferProofResult>
```

Generate a Groth16 ZK proof for `JanusToken.confidentialTransfer`.

```typescript
interface TransferProofInput {
  oldBalance: bigint;       // Current sender balance
  oldBlinding: bigint;      // Blinding used at wrap/mint time
  transferAmount: bigint;   // Amount to transfer
  transferBlinding: bigint; // Fresh random blinding for transfer
  newBlinding: bigint;      // Fresh random blinding for residual
  wasmPath: string;         // Path to circuit .wasm
  zkeyPath: string;         // Path to proving key .zkey
  vkPath?: string;          // Optional: path to verification key JSON
}

interface TransferProofResult {
  proof: ProofUint256;           // uint256[8] — pass to confidentialTransfer
  publicInputs: PublicInputsUint256; // uint256[6] — pass to confidentialTransfer
  commitments: { oldCommit, transferCommit, newCommit }; // for storage
  locallyVerified: boolean;      // true if vkPath was provided and proof passed
}
```

### generateBlinding

```typescript
generateBlinding(): bigint
```

Generate a cryptographically random 128-bit blinding factor.
**Store this value** — you need it to decrypt balances and generate proofs.

### addCommitments

```typescript
addCommitments(a: CommitmentXY, b: CommitmentXY): Promise<CommitmentXY>
```

Homomorphic addition: `Pedersen(a, r1) + Pedersen(b, r2) = Pedersen(a+b, r1+r2)`

### decryptBalance

```typescript
decryptBalance(commit: CommitmentXY, blinding: bigint, maxValue?: bigint): Promise<bigint | null>
```

Brute-force decrypt a balance (testing only, O(maxValue) operations).
Production apps store the (value, blinding) pair at mint time.

---

## Network helpers

```typescript
createEvmProvider(network: FlowNetwork): Promise<JsonRpcProvider>
createEvmWallet(privateKey: string, network: FlowNetwork): Promise<Wallet>
configureFCL(network: FlowNetwork): Promise<void>

NETWORK_CONFIG: {
  testnet: { evmRpc: string, flowAccessApi: string, chainId: 545 },
  mainnet: { evmRpc: string, flowAccessApi: string, chainId: 747 },
}
```

---

## Primitives (power users)

### primitives.babyjub

```typescript
isOnCurveLocal(x: bigint, y: bigint): boolean
negatePoint(x: bigint, y: bigint): Point
isIdentity(x: bigint, y: bigint): boolean
babyAddOnChain(p1, p2, opts?): Promise<Point>
isOnCurveOnChain(x, y, opts?): Promise<boolean>
negateOnChain(x, y, opts?): Promise<Point>
GENERATOR_G: Point
CURVE_A: bigint   // 168700n
CURVE_D: bigint   // 168696n
BABYJUB_CONTRACT_ADDRESS: string
```

### primitives.pedersen

```typescript
computeCommitment(value, blinding): Promise<CommitmentXY>
addCommitmentsLocal(c1, c2): Promise<CommitmentXY>
subCommitmentsLocal(c1, c2): Promise<CommitmentXY>
negateCommitment(c): CommitmentXY
identityCommitment(): CommitmentXY
isIdentityCommitment(c): boolean
```

### primitives.groth16

```typescript
prove(input, opts: { wasmPath, zkeyPath }): Promise<{proof: SnarkJSProof, publicSignals}>
proveForEVM(input, opts): Promise<{rawProof, evmProof, proofUint256, publicSignals}>
verifyOnChain(proof, publicSignals, opts?): Promise<boolean>
verifyLocally(vk, proof, publicSignals): Promise<boolean>
proofToEVMFormat(proof: SnarkJSProof): EVMProof   // applies pi_b swap
pubSignalsToArray(signals): PublicInputsUint256
parsePublicSignals(raw: string[]): ConfidentialTransferPublicInputs
VERIFIER_ADDRESS: string
```

### utils

```typescript
bigintToHex(n: bigint, bytes?: number): string
hexToBigint(hex: string): bigint
padHex(hex: string, bytes?: number): string
applyPiBSwap(proof: SnarkJSProof): EVMProof
evmProofToUint256Array(evmProof: EVMProof): ProofUint256
```

---

## Types

```typescript
// Curve / commitment
interface Point { x: bigint; y: bigint; }
type CommitmentXY = Point;
const CURVE_P: bigint;  // BN254 scalar field prime
const IDENTITY_POINT: Point;  // { x: 0n, y: 1n }

// Proof
interface SnarkJSProof { pi_a, pi_b, pi_c, protocol, curve; }
interface EVMProof { pA, pB, pC; }
type ProofUint256 = [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
type PublicInputsUint256 = [bigint, bigint, bigint, bigint, bigint, bigint];
interface ConfidentialTransferPublicInputs {
  oldCommitX, oldCommitY, transferCommitX, transferCommitY, newCommitX, newCommitY: bigint;
}

// Network
type FlowNetwork = "testnet" | "mainnet";
```
