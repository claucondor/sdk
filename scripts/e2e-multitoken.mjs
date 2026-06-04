/**
 * e2e-multitoken.mjs — v0.6.6 End-to-End validation script.
 *
 * Real proofs, real contracts, real on-chain state. No stubs.
 * Runs in Node.js using SDK dist + snarkjs + circomlibjs.
 *
 * Test matrix (3 tokens × 2 recipients = 6 test cases):
 *   Token: flow | mockusdc | mockft (cadence-ft)
 *   Recipient: EVM-only sim | Cadence+COA sim
 *
 * For each EVM token test case (Tests 1-4):
 *   1. Publish fresh memokey for sender
 *   2. Wrap tokens (real AmountDisclose proof, COA sends tx)
 *   3. Verify on-chain commitment != identity AND matches local computation
 *   4. Shielded transfer half to recipient (real ConfidentialTransfer proof)
 *   5. Verify sender and recipient commitments updated
 *   6. Unwrap remaining balance
 *   7. Verify totalLocked decremented
 *
 * For each MockFT (cadence-ft) test case (Tests 5-6):
 *   1. Admin reset deployer commitment to identity
 *   2. Generate fresh BabyJub keypair + publish Cadence memokey for sender (deployer)
 *   3. Mint MockFT to deployer (using Minter resource)
 *   4. Wrap MockFT (Cadence tx: CommitmentRegistry.wrap + cross-VM BabyJub)
 *   5. Verify on-chain commitment != identity AND matches local computation
 *   6. Shielded transfer half to recipient (Cadence tx: shieldedTransfer)
 *   7. Verify sender and recipient commitments updated
 *   8. Sender unwraps remaining balance → MockFT vault
 *   9. Verify totalLocked decremented
 *
 * MockFT architecture note: JanusFT is Cadence-native. Commitments are indexed
 * by Cadence address (not EVM COA). The deployer (0x7599043aea001283) holds the
 * CommitmentRegistry + COA + Minter, so it acts as the sender for both MockFT
 * tests. Recipients are Cadence accounts with Cadence memokeys:
 *   Test 5 → charlie (0x3c601a443c81e6cd): existing memokey + MockFT receiver
 *   Test 6 → eve (0x374a28ddf00498e4): fresh memokey published in setup step
 * This validates the full Cadence-FT shielded path with real ZK proofs.
 *
 * DNS note: WSL DNS is flaky for *.onflow.org. The script applies a dns.lookup
 * patch (using the resolved IP 129.213.111.42) before loading any network
 * library, so FCL REST calls succeed even when the WSL nameserver times out.
 *
 * Run:
 *   node scripts/e2e-multitoken.mjs
 */

// ── DNS patch — MUST be first, before any networking library loads ────────────
// Patches dns.lookup to map Flow testnet hostnames to their IP (129.213.111.42).
// Workaround for WSL DNS resolution failures for *.onflow.org.
import { createRequire as _createRequire } from "module";
const _require = _createRequire(import.meta.url);
const _dns = _require("dns");
const _FLOW_DNS = {
  "rest-testnet.onflow.org":        "129.213.111.42",
  "access.devnet.nodes.onflow.org": "129.213.111.42",
  "testnet.evm.nodes.onflow.org":   "129.213.111.42",
};
const _origDnsLookup = _dns.lookup.bind(_dns);
_dns.lookup = function(hostname, optOrCb, maybeCb) {
  const opts     = (typeof optOrCb === "object" && optOrCb !== null) ? optOrCb : {};
  const callback = typeof optOrCb === "function" ? optOrCb : maybeCb;
  if (_FLOW_DNS[hostname] && typeof callback === "function") {
    const ip = _FLOW_DNS[hostname];
    return opts.all
      ? callback(null, [{ address: ip, family: 4 }])
      : callback(null, ip, 4);
  }
  return _origDnsLookup(hostname, optOrCb, maybeCb);
};

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

// ── FCL + crypto imports (for MockFT Cadence-native path) ────────────────────
// FCL uses REST API (https://rest-testnet.onflow.org) — NOT gRPC — so it works
// even when WSL gRPC DNS is broken. The DNS patch above ensures REST resolves too.
const fcl = await import("@onflow/fcl").then(m => m.default ?? m);
const elliptic = _require("elliptic");
const hashjs   = _require("hash.js");
const sha3pkg  = _require("sha3");

fcl.config({ ...fcl.flowTestnet });

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT  = join(__dirname, "..");

// Circuit artifact paths (v0.3 — tested, deployed ceremony)
const CIRCUITS_DIR  = join(SDK_ROOT, "circuits", "v0.3");
const AMOUNT_WASM   = join(CIRCUITS_DIR, "amount_disclose.wasm");
const AMOUNT_ZKEY   = join(CIRCUITS_DIR, "amount_disclose_final.zkey");
const CT_WASM       = join(CIRCUITS_DIR, "confidential_transfer.wasm");
const CT_ZKEY       = join(CIRCUITS_DIR, "confidential_transfer_final.zkey");

// Import from SDK dist
const SDK_DIST = join(SDK_ROOT, "dist");
const { buildAmountDiscloseProof, buildShieldedTransferProof,
        generateBabyJubKeypair, generateBlinding,
        encryptSnapshot, decryptSnapshot,
        encryptNote, decryptNote }
  = await import(join(SDK_DIST, "crypto/index.js"));
const { computeCommitment } = await import(join(SDK_DIST, "primitives/index.js"));

// ── Admin for adminResetSlot (testnet-only) ───────────────────────────────────
const ADMIN_SIGNER  = "v066-admin";
const ADMIN_COA_EVM = "0x000000000000000000000002656f9205e386ed78";

// ── Contract addresses (v0.6.6 clean deploy) ──────────────────────────────────
const JF_PROXY    = "0x2f4b9b63C869076c9dBE89626e340Fc7741fcE59";   // JanusFlow
const ERC20_PROXY = "0x4689a36427115a6023BEb8c8b3c38E6fDF5Ae84F";   // JanusERC20
const MOCKUSDC    = "0x686E8d90A7B608540cAF46E527fD8a5631A1b658";   // MockUSDC
const REGISTRY    = "0x05D104962ff087441f26BA11A1E1C3b9E091D663";   // MemoKeyRegistry (shared)

// Sender accounts (have COAs, will publish fresh memokeys)
const BOB_COA_EVM   = "0x00000000000000000000000250d93efba617e0bf";  // bob's COA
const DAVE_COA_EVM  = "0x0000000000000000000000027b94cfc8a64971cd";  // dave's COA

// ── MockFT (cadence-ft) configuration ─────────────────────────────────────────
// JanusFT is Cadence-native: commitments are keyed by Cadence address, not EVM COA.
// Deployer (testnet-claucondor) holds CommitmentRegistry + Minter + COA.
// Recipients are Cadence accounts with /public/openjanusMemoKey published.
//
// Test 5 recipient: charlie (0x3c601a443c81e6cd) — existing Cadence memokey
// Test 6 recipient: eve (0x374a28ddf00498e4)    — memokey published during test setup

const JANUFT_ADDR       = "0x7599043aea001283";  // deployer = registry + minter holder
const MOCKFT_ADDR       = "0x7599043aea001283";  // MockFT deployed at same account

const DEPLOYER_CADENCE  = "0x7599043aea001283";  // testnet-claucondor
const CHARLIE_CADENCE   = "0x3c601a443c81e6cd";  // has registry + memokey + MockFT receiver
const EVE_CADENCE       = "0x374a28ddf00498e4";  // fresh memokey will be published in setup

// Private keys for FCL signing (loaded from ~/.flow/ at runtime)
const PKEYS = {
  deployer: readFileSync("/home/oydual3/.flow/testnet-claucondor.pkey", "utf8").trim(),
  charlie:  readFileSync("/home/oydual3/.flow/testnet-charlie.pkey",    "utf8").trim(),
  eve:      readFileSync("/home/oydual3/.flow/testnet-eve.pkey",        "utf8").trim(),
};

// Recipient sim accounts (memokeys already published in registry)
const EVM_SIM_ADDR    = "0x73C5174888B004406fcBBD4Fb7b32356a1d3734f";
const CADENCE_SIM_COA = "0x000000000000000000000002c010c708e68bfd7f";

// Flow config
const FLOW_JSON = "/tmp/v066_flow.json";
const RPC_URL   = "https://testnet.evm.nodes.onflow.org";
const provider  = new ethers.JsonRpcProvider(RPC_URL);

// ── ABIs ──────────────────────────────────────────────────────────────────────
const JF_ABI = [
  "function wrap(uint256[2] txCommit, uint256[8] amountProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external payable",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external",
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  "function feeBps() view returns (uint16)",
  "function balanceOfCommitmentXY(address) view returns (uint256, uint256)",
  "function totalLocked() view returns (uint256)",
];
const ERC20_ABI = [
  "function wrap(uint256 amount, uint256[2] txCommit, uint256[8] amountProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  "function shieldedTransfer(address to, uint256[6] publicInputs, uint256[8] proof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY, bytes encryptedNoteTo, uint256 ephPubkeyToX, uint256 ephPubkeyToY) external",
  "function unwrap(uint256 claimedAmount, address recipient, uint256[2] txCommit, uint256[8] amountProof, uint256[6] transferPublicInputs, uint256[8] transferProof, bytes encryptedSnapshot, uint256 ephPubkeyX, uint256 ephPubkeyY) external",
  "function feeBps() view returns (uint16)",
  "function balanceOfCommitmentXY(address) view returns (uint256, uint256)",
  "function totalLocked() view returns (uint256)",
];
const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const REGISTRY_ABI = [
  "function publishMemoKey(uint256 x, uint256 y) external",
  "function rotateMemoKey(uint256 newX, uint256 newY) external",
  "function getMemoKey(address user) view returns (uint256 x, uint256 y, uint256 publishedAt)",
];
const ADMIN_RESET_ABI = [
  "function adminResetSlot(address user) external",
];

// ── EVM helpers ───────────────────────────────────────────────────────────────

async function getCommitment(contractAddr, userAddr) {
  const iface = new ethers.Interface(JF_ABI);
  const data = iface.encodeFunctionData("balanceOfCommitmentXY", [userAddr]);
  const result = await provider.call({ to: contractAddr, data });
  const decoded = iface.decodeFunctionResult("balanceOfCommitmentXY", result);
  return { x: BigInt(decoded[0]), y: BigInt(decoded[1]) };
}

async function getTotalLocked(contractAddr) {
  const iface = new ethers.Interface(JF_ABI);
  const data = iface.encodeFunctionData("totalLocked", []);
  const result = await provider.call({ to: contractAddr, data });
  return BigInt(iface.decodeFunctionResult("totalLocked", result)[0]);
}

async function getFeeBps(contractAddr) {
  const iface = new ethers.Interface(JF_ABI);
  const data = iface.encodeFunctionData("feeBps", []);
  const result = await provider.call({ to: contractAddr, data });
  return Number(iface.decodeFunctionResult("feeBps", result)[0]);
}

async function getMemoKey(userEvmAddr) {
  const iface = new ethers.Interface(REGISTRY_ABI);
  const data = iface.encodeFunctionData("getMemoKey", [userEvmAddr]);
  const result = await provider.call({ to: REGISTRY, data });
  const decoded = iface.decodeFunctionResult("getMemoKey", result);
  const x = BigInt(decoded[0]);
  const y = BigInt(decoded[1]);
  return (x === 0n && y === 0n) ? null : { x, y };
}

function isIdentity(c) { return c.x === 0n && c.y === 1n; }
function commitEq(a, b) { return a.x === b.x && a.y === b.y; }

// ── Flow/Cadence helpers ──────────────────────────────────────────────────────

function runFlowTx(cadence, cadenceArgs, signer) {
  const txPath = `/tmp/.e2e_${Date.now()}_${Math.random().toString(36).slice(2)}.cdc`;
  writeFileSync(txPath, cadence);
  const quotedArgs = cadenceArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  const cmd = [
    `flow transactions send ${txPath}`,
    quotedArgs,
    "--network testnet",
    `--signer ${signer}`,
    "--gas-limit 9999",
    "--output json",
    `--config-path ${FLOW_JSON}`,
  ].join(" ");
  let result;
  try {
    const stdout = execSync(cmd, { timeout: 300_000, encoding: "utf8" });
    result = JSON.parse(stdout);
  } catch (err) {
    if (err.stdout) {
      try { result = JSON.parse(err.stdout); }
      catch { throw new Error(err.stdout?.slice(0, 500) || err.message); }
    } else {
      throw new Error(err.message.slice(0, 500));
    }
  }
  if (result.error) throw new Error(result.error.slice(0, 500));
  return { id: result.id };
}

const COA_CALL_TX = `import "EVM"

transaction(calldataHex: String, proxyHex: String, attoflow: UInt) {
  prepare(signer: auth(BorrowValue) &Account) {
    let coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
      ?? panic("No COA at /storage/evm")
    let result = coa.call(
      to: EVM.addressFromString(proxyHex),
      data: calldataHex.decodeHex(),
      gasLimit: 3_000_000,
      value: EVM.Balance(attoflow: attoflow)
    )
    assert(result.status == EVM.Status.successful,
      message: "EVM call reverted: ".concat(result.errorMessage)
        .concat(" revert data: 0x").concat(String.encodeHex(result.data)))
  }
}`;

function callEvmViaCoa(signer, proxyHex, calldataHex, attoflow = 0n) {
  return runFlowTx(COA_CALL_TX, [calldataHex, proxyHex, attoflow.toString()], signer);
}

// ── Admin helpers ─────────────────────────────────────────────────────────────

/**
 * adminResetSlot — testnet-only. Resets sender commitment to identity so each
 * test starts from a clean state, even if the sender account was used before.
 */
async function adminResetSlot(proxyAddr, targetAddr) {
  const iface = new ethers.Interface(ADMIN_RESET_ABI);
  const calldata = iface.encodeFunctionData("adminResetSlot", [targetAddr]).slice(2);
  return callEvmViaCoa(ADMIN_SIGNER, proxyAddr, calldata, 0n);
}

// ── Core test infrastructure ──────────────────────────────────────────────────

const testResults = [];

function step(n, msg) { console.log(`\n    [${n}] ${msg}`); }
function ok(msg)      { console.log(`    ✓ ${msg}`); }

async function runSingleTest(testName, token, senderSigner, senderCOA, recipientEVM, recipientLabel) {
  const isNative = (token === "flow");
  const proxyAddr = isNative ? JF_PROXY : ERC20_PROXY;
  const proxyAbi  = isNative ? JF_ABI    : ERC20_ABI;
  const proxyIface = new ethers.Interface(proxyAbi);

  console.log(`\n${"=".repeat(64)}`);
  console.log(`TEST: ${testName}`);
  console.log(`${"=".repeat(64)}`);

  try {
    // ── Pre: Reset sender slot (testnet-only, admin gate) ─────────────────
    step("Pre", "adminResetSlot — reset sender commitment to identity...");
    const resetTx = adminResetSlot(proxyAddr, senderCOA);
    ok(`Reset tx: ${resetTx.id}`);

    // ── A: Publish/rotate fresh memokey for sender ────────────────────────
    step("A", "Generate + publish sender memokey...");
    const senderKeypair = await generateBabyJubKeypair();
    const registryIface = new ethers.Interface(REGISTRY_ABI);
    const alreadyPublished = await getMemoKey(senderCOA);
    let pubCalldata, pubAction;
    if (alreadyPublished) {
      // Must use rotateMemoKey if already published
      pubCalldata = registryIface.encodeFunctionData("rotateMemoKey", [senderKeypair.pubkey.x, senderKeypair.pubkey.y]).slice(2);
      pubAction = "rotated";
    } else {
      pubCalldata = registryIface.encodeFunctionData("publishMemoKey", [senderKeypair.pubkey.x, senderKeypair.pubkey.y]).slice(2);
      pubAction = "published";
    }
    const pubTx = callEvmViaCoa(senderSigner, REGISTRY, pubCalldata, 0n);
    ok(`Memokey ${pubAction}: tx=${pubTx.id}`);

    const recipientMemoKey = await getMemoKey(recipientEVM);
    if (!recipientMemoKey) throw new Error(`Recipient ${recipientEVM} memokey not found in registry`);
    ok(`Recipient memokey confirmed`);

    // ── B: Setup — token-specific ─────────────────────────────────────────
    let grossWrap, netWrap, wrapCalldata, wrapBlinding;

    if (isNative) {
      // JanusFlow: wrap 1 FLOW
      step("B", "Prepare JanusFlow wrap (1.0 FLOW)...");
      grossWrap = ethers.parseEther("1.0"); // 10^18 attoflow
      const feeBps = await getFeeBps(proxyAddr);
      const fee = (grossWrap * BigInt(feeBps)) / 10000n;
      netWrap = grossWrap - fee;
    } else {
      // JanusERC20: mint + approve + wrap 100 mUSDC (6 decimals)
      step("B", "Mint + approve MockUSDC...");
      grossWrap = 100_000_000n; // 100 USDC (6 dec)
      const usdcIface = new ethers.Interface(USDC_ABI);
      const mintCalldata = usdcIface.encodeFunctionData("mint", [senderCOA, grossWrap]).slice(2);
      const mintTx = callEvmViaCoa(senderSigner, MOCKUSDC, mintCalldata, 0n);
      ok(`Minted 100 mUSDC: tx=${mintTx.id}`);
      const approveCalldata = usdcIface.encodeFunctionData("approve", [ERC20_PROXY, grossWrap]).slice(2);
      const approveTx = callEvmViaCoa(senderSigner, MOCKUSDC, approveCalldata, 0n);
      ok(`Approved JanusERC20: tx=${approveTx.id}`);
      const feeBps = await getFeeBps(proxyAddr);
      const fee = (grossWrap * BigInt(feeBps)) / 10000n;
      netWrap = grossWrap - fee;
    }

    // ── Step 1: Build wrap proof and submit ────────────────────────────────
    step("1", `Wrap: grossWrap=${grossWrap} netWrap=${netWrap}...`);
    wrapBlinding = generateBlinding();
    const wrapProof = await buildAmountDiscloseProof(
      { amount: netWrap, blinding: wrapBlinding },
      { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
    );
    ok(`AmountDisclose proof built: txCommit.x=${wrapProof.txCommit[0].toString().slice(0,12)}...`);

    const wrapSnapEnc = await encryptSnapshot(
      { balance: netWrap, blinding: wrapBlinding, timestampMs: Date.now() },
      senderKeypair.pubkey
    );

    if (isNative) {
      wrapCalldata = proxyIface.encodeFunctionData("wrap", [
        [wrapProof.txCommit[0], wrapProof.txCommit[1]],
        [...wrapProof.proof],
        ethers.hexlify(wrapSnapEnc.ciphertext),
        wrapSnapEnc.ephemeralPubkey.x,
        wrapSnapEnc.ephemeralPubkey.y,
      ]).slice(2);
    } else {
      wrapCalldata = proxyIface.encodeFunctionData("wrap", [
        grossWrap,
        [wrapProof.txCommit[0], wrapProof.txCommit[1]],
        [...wrapProof.proof],
        ethers.hexlify(wrapSnapEnc.ciphertext),
        wrapSnapEnc.ephemeralPubkey.x,
        wrapSnapEnc.ephemeralPubkey.y,
      ]).slice(2);
    }

    const totalLockedBefore = await getTotalLocked(proxyAddr);
    const wrapTx = callEvmViaCoa(senderSigner, proxyAddr, wrapCalldata, isNative ? grossWrap : 0n);
    ok(`Wrap tx: ${wrapTx.id}`);

    // ── Step 2: Verify commitment ─────────────────────────────────────────
    step("2", "Verify on-chain commitment...");
    const commitAfterWrap = await getCommitment(proxyAddr, senderCOA);
    const totalLockedAfterWrap = await getTotalLocked(proxyAddr);
    if (isIdentity(commitAfterWrap)) throw new Error("Commitment still identity after wrap — tx may have silently failed");
    if (totalLockedAfterWrap <= totalLockedBefore) throw new Error(`totalLocked did not increase: ${totalLockedBefore} → ${totalLockedAfterWrap}`);
    ok(`totalLocked increased: ${totalLockedBefore} → ${totalLockedAfterWrap}`);

    // Critical check: local commitment matches on-chain
    const localCommit = await computeCommitment(netWrap, wrapBlinding);
    if (!commitEq(commitAfterWrap, localCommit)) {
      throw new Error(
        `COMMITMENT MISMATCH — local=(${localCommit.x.toString().slice(0,12)},${localCommit.y.toString().slice(0,12)}) ` +
        `chain=(${commitAfterWrap.x.toString().slice(0,12)},${commitAfterWrap.y.toString().slice(0,12)})`
      );
    }
    ok(`Local commitment matches on-chain (cryptographic consistency verified)`);

    // ── Step 3: Shielded transfer ──────────────────────────────────────────
    step("3", `Shielded transfer ${netWrap / 2n} to recipient ${recipientEVM.slice(0,12)}...`);
    const transferAmount = netWrap / 2n;
    const transferBlinding = generateBlinding();
    const newBlinding = generateBlinding();

    const ctProof = await buildShieldedTransferProof(
      {
        oldBalance: netWrap,
        oldBlinding: wrapBlinding,
        transferAmount,
        transferBlinding,
        newBlinding,
      },
      { wasmPath: CT_WASM, zkeyPath: CT_ZKEY }
    );
    ok(`ConfidentialTransfer proof built`);

    // Critical: C_old from proof MUST match on-chain commitment
    if (ctProof.publicInputs[0] !== commitAfterWrap.x || ctProof.publicInputs[1] !== commitAfterWrap.y) {
      throw new Error(
        `C_old mismatch before ST submission: ` +
        `proof=(${ctProof.publicInputs[0].toString().slice(0,12)}) ` +
        `chain=(${commitAfterWrap.x.toString().slice(0,12)})`
      );
    }
    ok(`C_old matches on-chain commitment — proof will pass`);

    const newBalance = netWrap - transferAmount;
    const stSnapEnc = await encryptSnapshot(
      { balance: newBalance, blinding: newBlinding, timestampMs: Date.now() },
      senderKeypair.pubkey
    );
    const recipNoteEnc = await encryptNote(
      { amount: transferAmount, blinding: transferBlinding },
      recipientMemoKey
    );

    const stCalldata = proxyIface.encodeFunctionData("shieldedTransfer", [
      recipientEVM,
      [...ctProof.publicInputs],
      [...ctProof.proof],
      ethers.hexlify(stSnapEnc.ciphertext),
      stSnapEnc.ephemeralPubkey.x,
      stSnapEnc.ephemeralPubkey.y,
      ethers.hexlify(recipNoteEnc.ciphertext),
      recipNoteEnc.ephemeralPubkey.x,
      recipNoteEnc.ephemeralPubkey.y,
    ]).slice(2);

    const recipCommitBefore = await getCommitment(proxyAddr, recipientEVM);
    const stTx = callEvmViaCoa(senderSigner, proxyAddr, stCalldata, 0n);
    ok(`ShieldedTransfer tx: ${stTx.id}`);

    // ── Step 4: Verify both commitments updated ────────────────────────────
    step("4", "Verify commitments updated after shielded transfer...");
    const senderCommitAfterST = await getCommitment(proxyAddr, senderCOA);
    const recipCommitAfterST  = await getCommitment(proxyAddr, recipientEVM);
    if (isIdentity(senderCommitAfterST)) throw new Error("Sender commitment is identity after ST");
    if (commitEq(recipCommitAfterST, recipCommitBefore)) throw new Error("Recipient commitment did not change after ST");
    ok(`Sender commit changed, recipient commit updated`);

    // ── Step 5: Unwrap remaining balance ───────────────────────────────────
    step("5", `Unwrap ${newBalance} (remaining balance)...`);

    const newBlinding2 = generateBlinding();
    const unwrapAdProof = await buildAmountDiscloseProof(
      { amount: newBalance, blinding: newBlinding2 },
      { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
    );

    const newBlinding3 = generateBlinding();
    const unwrapCtProof = await buildShieldedTransferProof(
      {
        oldBalance: newBalance,
        oldBlinding: newBlinding,
        transferAmount: newBalance,    // full remaining balance
        transferBlinding: newBlinding2, // must match amount-disclose
        newBlinding: newBlinding3,      // residual commitment (will be zero)
      },
      { wasmPath: CT_WASM, zkeyPath: CT_ZKEY }
    );

    // Verify C_old of unwrap proof matches on-chain
    if (unwrapCtProof.publicInputs[0] !== senderCommitAfterST.x ||
        unwrapCtProof.publicInputs[1] !== senderCommitAfterST.y) {
      throw new Error(`Unwrap C_old mismatch`);
    }
    // Verify C_tx consistency between the two unwrap proofs
    if (unwrapAdProof.txCommit[0] !== unwrapCtProof.publicInputs[2] ||
        unwrapAdProof.txCommit[1] !== unwrapCtProof.publicInputs[3]) {
      throw new Error(`Unwrap C_tx mismatch between amount-disclose and confidential-transfer`);
    }
    ok(`Unwrap proof consistency verified (C_old and C_tx match)`);

    const unwrapSnapEnc = await encryptSnapshot(
      { balance: 0n, blinding: newBlinding3, timestampMs: Date.now() },
      senderKeypair.pubkey
    );

    const unwrapCalldata = proxyIface.encodeFunctionData("unwrap", [
      newBalance,
      senderCOA, // return funds to sender COA
      [unwrapAdProof.txCommit[0], unwrapAdProof.txCommit[1]],
      [...unwrapAdProof.proof],
      [...unwrapCtProof.publicInputs],
      [...unwrapCtProof.proof],
      ethers.hexlify(unwrapSnapEnc.ciphertext),
      unwrapSnapEnc.ephemeralPubkey.x,
      unwrapSnapEnc.ephemeralPubkey.y,
    ]).slice(2);

    const totalLockedBeforeUnwrap = await getTotalLocked(proxyAddr);
    const unwrapTx = callEvmViaCoa(senderSigner, proxyAddr, unwrapCalldata, 0n);
    ok(`Unwrap tx: ${unwrapTx.id}`);

    // ── Step 6: Verify totalLocked decremented ─────────────────────────────
    step("6", "Verify totalLocked decremented after unwrap...");
    const totalLockedAfterUnwrap = await getTotalLocked(proxyAddr);
    const expectedLocked = totalLockedBeforeUnwrap - newBalance;
    if (totalLockedAfterUnwrap !== expectedLocked) {
      throw new Error(
        `totalLocked mismatch: expected ${expectedLocked}, got ${totalLockedAfterUnwrap}`
      );
    }
    ok(`totalLocked: ${totalLockedBeforeUnwrap} → ${totalLockedAfterUnwrap} (decremented by ${newBalance})`);

    console.log(`\n  PASS: ${testName}`);
    testResults.push({
      name: testName, passed: true,
      transferAmount: transferAmount.toString(),
      wrapTxId: wrapTx.id,
      stTxId: stTx.id,
      unwrapTxId: unwrapTx.id,
    });
  } catch (err) {
    console.error(`\n  FAIL: ${testName}: ${err.message}`);
    testResults.push({ name: testName, passed: false, error: err.message });
  }
}

// ── FCL signing helpers ───────────────────────────────────────────────────────

/**
 * makeAuthz — Build an FCL authorizer from a raw private key hex string.
 *
 * @param {string} address  Cadence address with 0x prefix
 * @param {number} keyIndex Account key index (usually 0)
 * @param {string} pkeyHex  64-char hex private key (no 0x prefix)
 * @param {string} algo     "secp256k1" (SHA2-256) | "p256" (SHA3-256)
 */
function makeAuthz(address, keyIndex, pkeyHex, algo = "p256") {
  let ec, hashFn;
  if (algo === "secp256k1") {
    ec     = new elliptic.ec("secp256k1");
    hashFn = (bytes) => hashjs.sha256().update(bytes).digest("hex");
  } else {
    ec     = new elliptic.ec("p256");
    hashFn = (bytes) => {
      const SHA3 = sha3pkg.SHA3;
      const h = new SHA3(256);
      h.update(bytes);
      return h.digest("hex");
    };
  }
  const keyPair = ec.keyFromPrivate(pkeyHex, "hex");
  return (account) => ({
    ...account,
    addr:  fcl.withPrefix(address),
    keyId: keyIndex,
    signingFunction: async ({ message }) => {
      const msgBytes = Buffer.from(message, "hex");
      const hash     = hashFn(msgBytes);
      const sig      = keyPair.sign(hash);
      const r        = sig.r.toString("hex").padStart(64, "0");
      const s        = sig.s.toString("hex").padStart(64, "0");
      return { addr: fcl.withPrefix(address), keyId: keyIndex, signature: r + s };
    },
  });
}

// testnet-claucondor uses secp256k1 + SHA2-256 (verified against on-chain pubkey)
const deployerAuthz = makeAuthz(DEPLOYER_CADENCE, 0, PKEYS.deployer, "secp256k1");
// charlie and eve use P256 + SHA3-256 (standard new account key type)
const charlieAuthz  = makeAuthz(CHARLIE_CADENCE, 0, PKEYS.charlie, "p256");
const eveAuthz      = makeAuthz(EVE_CADENCE,     0, PKEYS.eve,     "p256");

// ── FCL query helper ──────────────────────────────────────────────────────────

async function cadenceQuery(cadence, args = []) {
  return fcl.query({ cadence, args: args.length ? (arg, t) => args.map(a => a(arg, t)) : [] });
}

// ── JanusFT on-chain read helpers ─────────────────────────────────────────────

async function getFTCommitment(account) {
  const c = await cadenceQuery(`
    import JanusFT from ${JANUFT_ADDR}
    access(all) fun main(addr: Address): [UInt256] {
      let c = JanusFT.balanceOfCommitment(account: addr)
      return [c.x, c.y]
    }
  `, [(arg, t) => arg(account, t.Address)]);
  return { x: BigInt(c[0]), y: BigInt(c[1]) };
}

async function getFTTotalLocked() {
  const v = await cadenceQuery(`
    import JanusFT from ${JANUFT_ADDR}
    access(all) fun main(): UFix64 { return JanusFT.getTotalLocked() }
  `);
  // UFix64 arrives as decimal string e.g. "0.99900000"
  return BigInt(Math.round(parseFloat(v) * 1e8));
}

async function getCadenceMemoKey(account) {
  const result = await cadenceQuery(`
    import JanusFlow from 0x5dcbeb41055ec57e
    access(all) fun main(addr: Address): [UInt256] {
      if let mk = getAccount(addr).capabilities.borrow<&{JanusFlow.MemoKeyPublic}>(/public/openjanusMemoKey) {
        return [mk.getPubkeyX(), mk.getPubkeyY()]
      }
      return [0, 1]
    }
  `, [(arg, t) => arg(account, t.Address)]);
  const x = BigInt(result[0]);
  const y = BigInt(result[1]);
  return (x === 0n && y === 1n) ? null : { x, y };
}

// ── JanusFT tx helpers ────────────────────────────────────────────────────────

/**
 * publishCadenceMemoKey — publish or rotate Cadence memokey for an account.
 * The account must sign (fcl authz). Writes to /storage/openjanusMemoKey AND
 * to the EVM MemoKeyRegistry (via COA cross-VM call, if account has COA).
 *
 * For accounts without COA (charlie, eve), the publish_memokey_ft transaction
 * would fail at the COA borrow. We use JanusFT.publishMemoKey() directly via a
 * simpler transaction that only writes the Cadence storage path.
 */
async function publishCadenceMemoKeyOnly(authz, address, pubkeyX, pubkeyY) {
  const txId = await fcl.mutate({
    cadence: `
      import JanusFlow from 0x5dcbeb41055ec57e
      transaction(pubkeyX: UInt256, pubkeyY: UInt256) {
        prepare(signer: auth(SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account) {
          let storagePath = JanusFlow.memoKeyStoragePath()
          let publicPath  = JanusFlow.memoKeyPublicPath()
          if let anyOld <- signer.storage.load<@AnyResource>(from: storagePath) {
            destroy anyOld
            signer.capabilities.unpublish(publicPath)
          }
          let key <- JanusFlow.createMemoKey(pubkeyX: pubkeyX, pubkeyY: pubkeyY)
          signer.storage.save(<- key, to: storagePath)
          let cap = signer.capabilities.storage.issue<&{JanusFlow.MemoKeyPublic}>(storagePath)
          signer.capabilities.publish(cap, at: publicPath)
        }
      }
    `,
    args: (arg, t) => [
      arg(pubkeyX.toString(), t.UInt256),
      arg(pubkeyY.toString(), t.UInt256),
    ],
    proposer:       authz,
    payer:          authz,
    authorizations: [authz],
    limit: 9999,
  });
  await fcl.tx(txId).onceSealed();
  return txId;
}

/**
 * ftAdminReset — reset deployer's commitment to identity (testnet-only).
 * Uses the Admin resource on the deployer account.
 */
async function ftAdminReset(account) {
  const txId = await fcl.mutate({
    cadence: `
      import JanusFT from ${JANUFT_ADDR}
      transaction(target: Address) {
        prepare(signer: auth(BorrowValue) &Account) {
          let admin = signer.storage.borrow<&JanusFT.Admin>(from: JanusFT.AdminStoragePath)
            ?? panic("Admin not found")
          admin.resetCommitmentsForTestingOnly(account: target)
        }
      }
    `,
    args: (arg, t) => [arg(account, t.Address)],
    proposer:       deployerAuthz,
    payer:          deployerAuthz,
    authorizations: [deployerAuthz],
    limit: 9999,
  });
  await fcl.tx(txId).onceSealed();
  return txId;
}

/**
 * ftMintToDeployer — mint MockFT to the deployer's own vault.
 * Only the Minter resource (at deployer's /storage/mockFTMinter) can mint.
 */
async function ftMintToDeployer(grossAmountUfix64Str) {
  const txId = await fcl.mutate({
    cadence: `
      import MockFT from ${MOCKFT_ADDR}
      import FungibleToken from 0x9a0766d93b6608b7
      transaction(amount: UFix64) {
        prepare(signer: auth(BorrowValue) &Account) {
          let minter = signer.storage.borrow<&MockFT.Minter>(from: MockFT.MinterStoragePath)
            ?? panic("Minter not found")
          let vault = signer.storage.borrow<&MockFT.Vault>(from: MockFT.VaultStoragePath)
            ?? panic("Vault not found")
          let tokens <- minter.mintTokens(amount: amount)
          vault.deposit(from: <- tokens)
        }
      }
    `,
    args: (arg, t) => [arg(grossAmountUfix64Str, t.UFix64)],
    proposer:       deployerAuthz,
    payer:          deployerAuthz,
    authorizations: [deployerAuthz],
    limit: 9999,
  });
  await fcl.tx(txId).onceSealed();
  return txId;
}

/**
 * ftWrap — wrap MockFT into JanusFT commitment.
 *
 * This calls CommitmentRegistry.wrap() which:
 *   - Verifies the amount-disclose ZK proof cross-VM
 *   - Deducts fee, deposits tokens into custody vault
 *   - Calls BabyJub.add cross-VM to update commitment
 *
 * The signer must hold: JanusFT.CommitmentRegistry, MockFT.Vault, EVM.COA
 * Only the deployer satisfies all three.
 */
async function ftWrap(grossAmountUfix64Str, netAmountUfix64Str, txCommitX, txCommitY,
                      amountProof, amountPublicInputs, encryptedSnapshotHex, ephPubX, ephPubY) {
  const txId = await fcl.mutate({
    cadence: `
      import JanusFT from ${JANUFT_ADDR}
      import MockFT from ${MOCKFT_ADDR}
      import FungibleToken from 0x9a0766d93b6608b7
      import EVM from 0x8c5303eaa26202d6
      transaction(
          grossAmount: UFix64, netAmount: UFix64,
          txCommitX: UInt256, txCommitY: UInt256,
          amountProof: [UInt256], amountPublicInputs: [UInt256],
          encryptedSnapshotHex: String, ephPubX: UInt256, ephPubY: UInt256
      ) {
        let depositVault: @{FungibleToken.Vault}
        let registryRef:  &JanusFT.CommitmentRegistry
        let senderAddress: Address
        let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
        prepare(signer: auth(BorrowValue) &Account) {
          self.senderAddress = signer.address
          let userVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &MockFT.Vault>(
            from: MockFT.VaultStoragePath
          ) ?? panic("No MockFT vault")
          self.depositVault <- userVault.withdraw(amount: grossAmount)
          self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
          ) ?? panic("No JanusFT registry")
          self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
          ) ?? panic("No COA")
        }
        execute {
          let snapBytes: [UInt8] = encryptedSnapshotHex.length == 0
            ? []
            : encryptedSnapshotHex.decodeHex()
          self.registryRef.wrap(
            account:            self.senderAddress,
            netAmount:          netAmount,
            depositVault:       <- self.depositVault,
            txCommit:           JanusFT.Commitment(x: txCommitX, y: txCommitY),
            amountProof:        amountProof,
            amountPublicInputs: amountPublicInputs,
            encryptedSnapshot:  snapBytes,
            ephPubX:            ephPubX,
            ephPubY:            ephPubY,
            coa:                self.coa
          )
        }
      }
    `,
    args: (arg, t) => [
      arg(grossAmountUfix64Str,            t.UFix64),
      arg(netAmountUfix64Str,              t.UFix64),
      arg(txCommitX.toString(),            t.UInt256),
      arg(txCommitY.toString(),            t.UInt256),
      arg(bigintArrayToStrings(amountProof),        t.Array(t.UInt256)),
      arg(bigintArrayToStrings(amountPublicInputs), t.Array(t.UInt256)),
      arg(encryptedSnapshotHex,            t.String),
      arg(ephPubX.toString(),              t.UInt256),
      arg(ephPubY.toString(),              t.UInt256),
    ],
    proposer:       deployerAuthz,
    payer:          deployerAuthz,
    authorizations: [deployerAuthz],
    limit: 9999,
  });
  const res = await fcl.tx(txId).onceSealed();
  if (res.errorMessage) throw new Error(`ftWrap sealed with error: ${res.errorMessage}`);
  return txId;
}

/**
 * ftShieldedTransfer — move a hidden amount between Cadence accounts.
 * Only updates commitments in JanusFT contract storage; no vault movement.
 * Signer must hold registry + COA (only deployer).
 */
async function ftShieldedTransfer(
  fromAccount, toAccount,
  transferProof, publicInputs,
  encryptedSnapshotFromHex, ephPubFromX, ephPubFromY,
  encryptedNoteToHex, ephPubToX, ephPubToY
) {
  const txId = await fcl.mutate({
    cadence: `
      import JanusFT from ${JANUFT_ADDR}
      import EVM from 0x8c5303eaa26202d6
      transaction(
          fromAccount: Address, toAccount: Address,
          transferProof: [UInt256], publicInputs: [UInt256],
          encryptedSnapshotFromHex: String, ephPubFromX: UInt256, ephPubFromY: UInt256,
          encryptedNoteToHex: String, ephPubToX: UInt256, ephPubToY: UInt256
      ) {
        let registryRef: &JanusFT.CommitmentRegistry
        let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
        prepare(signer: auth(BorrowValue) &Account) {
          self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
          ) ?? panic("No registry")
          self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
          ) ?? panic("No COA")
        }
        execute {
          self.registryRef.shieldedTransfer(
            fromAccount:           fromAccount,
            toAccount:             toAccount,
            transferProof:         transferProof,
            publicInputs:          publicInputs,
            encryptedSnapshotFrom: encryptedSnapshotFromHex.length == 0 ? [] : encryptedSnapshotFromHex.decodeHex(),
            ephPubFromX:           ephPubFromX,
            ephPubFromY:           ephPubFromY,
            encryptedNoteTo:       encryptedNoteToHex.length == 0 ? [] : encryptedNoteToHex.decodeHex(),
            ephPubToX:             ephPubToX,
            ephPubToY:             ephPubToY,
            coa:                   self.coa
          )
        }
      }
    `,
    args: (arg, t) => [
      arg(fromAccount,                         t.Address),
      arg(toAccount,                           t.Address),
      arg(bigintArrayToStrings(transferProof), t.Array(t.UInt256)),
      arg(bigintArrayToStrings(publicInputs),  t.Array(t.UInt256)),
      arg(encryptedSnapshotFromHex,            t.String),
      arg(ephPubFromX.toString(),              t.UInt256),
      arg(ephPubFromY.toString(),              t.UInt256),
      arg(encryptedNoteToHex,                  t.String),
      arg(ephPubToX.toString(),                t.UInt256),
      arg(ephPubToY.toString(),                t.UInt256),
    ],
    proposer:       deployerAuthz,
    payer:          deployerAuthz,
    authorizations: [deployerAuthz],
    limit: 9999,
  });
  const res = await fcl.tx(txId).onceSealed();
  if (res.errorMessage) throw new Error(`ftShieldedTransfer sealed with error: ${res.errorMessage}`);
  return txId;
}

/**
 * ftUnwrap — unwrap deployer's remaining commitment back to their MockFT vault.
 * Signer must hold registry + COA. Recipient receives net tokens (gross - fee).
 *
 * Note: recipient must have /public/mockFTReceiver published.
 * For self-unwrap (deployer → deployer), the deployer has their own vault.
 */
async function ftUnwrap(
  senderCadence, recipientCadence, claimedAmountUfix64Str,
  txCommitX, txCommitY,
  amountProof, amountPublicInputs,
  transferProof, transferPublicInputs,
  encryptedSnapshotHex, ephPubX, ephPubY
) {
  const txId = await fcl.mutate({
    cadence: `
      import JanusFT from ${JANUFT_ADDR}
      import MockFT from ${MOCKFT_ADDR}
      import FungibleToken from 0x9a0766d93b6608b7
      import EVM from 0x8c5303eaa26202d6
      transaction(
          account: Address, claimedAmount: UFix64, recipient: Address,
          txCommitX: UInt256, txCommitY: UInt256,
          amountProof: [UInt256], amountPublicInputs: [UInt256],
          transferProof: [UInt256], transferPublicInputs: [UInt256],
          encryptedSnapshotHex: String, ephPubX: UInt256, ephPubY: UInt256
      ) {
        let registryRef:  &JanusFT.CommitmentRegistry
        let coa:          auth(EVM.Call) &EVM.CadenceOwnedAccount
        let recipientRef: &{FungibleToken.Receiver}
        prepare(signer: auth(BorrowValue) &Account) {
          self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
          ) ?? panic("No registry")
          self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
          ) ?? panic("No COA")
          self.recipientRef = getAccount(recipient)
            .capabilities.borrow<&{FungibleToken.Receiver}>(MockFT.ReceiverPublicPath)
            ?? panic("Recipient has no MockFT receiver")
        }
        execute {
          let netVault <- self.registryRef.unwrap(
            account:               account,
            claimedAmount:         claimedAmount,
            recipient:             recipient,
            txCommit:              JanusFT.Commitment(x: txCommitX, y: txCommitY),
            amountProof:           amountProof,
            amountPublicInputs:    amountPublicInputs,
            transferProof:         transferProof,
            transferPublicInputs:  transferPublicInputs,
            encryptedSnapshot:     encryptedSnapshotHex.length == 0 ? [] : encryptedSnapshotHex.decodeHex(),
            ephPubX:               ephPubX,
            ephPubY:               ephPubY,
            coa:                   self.coa
          )
          self.recipientRef.deposit(from: <- netVault)
        }
      }
    `,
    args: (arg, t) => [
      arg(senderCadence,                            t.Address),
      arg(claimedAmountUfix64Str,                   t.UFix64),
      arg(recipientCadence,                         t.Address),
      arg(txCommitX.toString(),                     t.UInt256),
      arg(txCommitY.toString(),                     t.UInt256),
      arg(bigintArrayToStrings(amountProof),         t.Array(t.UInt256)),
      arg(bigintArrayToStrings(amountPublicInputs),  t.Array(t.UInt256)),
      arg(bigintArrayToStrings(transferProof),       t.Array(t.UInt256)),
      arg(bigintArrayToStrings(transferPublicInputs), t.Array(t.UInt256)),
      arg(encryptedSnapshotHex,                     t.String),
      arg(ephPubX.toString(),                       t.UInt256),
      arg(ephPubY.toString(),                       t.UInt256),
    ],
    proposer:       deployerAuthz,
    payer:          deployerAuthz,
    authorizations: [deployerAuthz],
    limit: 9999,
  });
  const res = await fcl.tx(txId).onceSealed();
  if (res.errorMessage) throw new Error(`ftUnwrap sealed with error: ${res.errorMessage}`);
  return txId;
}

// UFix64 helpers: JanusFT uses UFix64 (8 decimal places, scale = 10^8)
// Amount in BigInt (raw 10^8 units) ↔ UFix64 decimal string ("1.50000000")
const FT_SCALE = 100_000_000n; // 10^8
function bigintToUFix64(v) {
  const whole = v / FT_SCALE;
  const frac  = v % FT_SCALE;
  return `${whole}.${frac.toString().padStart(8, "0")}`;
}
function ufix64ToBigint(s) {
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * FT_SCALE + BigInt(frac.padEnd(8, "0").slice(0, 8));
}

// FCL expects Array(UInt256) values as an array of decimal strings (not BigInt, not {type,value})
function bigintArrayToStrings(arr) { return arr.map(v => v.toString()); }

// ── MockFT E2E test runner ────────────────────────────────────────────────────

/**
 * runMockFTTest — Full wrap → shielded transfer → unwrap test for JanusFT (cadence-ft).
 *
 * @param {string} testName        Display name for this test.
 * @param {string} recipientCadence Cadence address of the shielded-transfer recipient.
 * @param {Function} recipientAuthzFn  FCL authz for the recipient (used to publish memokey).
 *                                     Pass null if recipient already has a memokey.
 */
async function runMockFTTest(testName, recipientCadence, recipientAuthzFn) {
  console.log(`\n${"=".repeat(64)}`);
  console.log(`TEST: ${testName}`);
  console.log(`${"=".repeat(64)}`);

  try {
    // ── Pre: Reset deployer's JanusFT commitment ─────────────────────────────
    step("Pre", "ftAdminReset — reset deployer commitment to identity...");
    const resetTxId = await ftAdminReset(DEPLOYER_CADENCE);
    ok(`Reset tx: ${resetTxId}`);

    // ── A: Publish/rotate memokey for SENDER (deployer, Cadence path) ────────
    // The deployer already has a Cadence memokey but we generate a fresh keypair
    // each test run for isolation.
    step("A", "Generate fresh sender BabyJub keypair + publish Cadence memokey...");
    const senderKeypair = await generateBabyJubKeypair();
    // deployer has COA so use the full publish_memokey_ft (both Cadence + EVM)
    const senderMemoTxId = await fcl.mutate({
      cadence: `
        import JanusFlow from 0x5dcbeb41055ec57e
        import EVM from 0x8c5303eaa26202d6
        transaction(memoPubX: UInt256, memoPubY: UInt256) {
          prepare(signer: auth(SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability, BorrowValue) &Account) {
            let storagePath = JanusFlow.memoKeyStoragePath()
            let publicPath  = JanusFlow.memoKeyPublicPath()
            if let anyOld <- signer.storage.load<@AnyResource>(from: storagePath) {
              destroy anyOld
              signer.capabilities.unpublish(publicPath)
            }
            let key <- JanusFlow.createMemoKey(pubkeyX: memoPubX, pubkeyY: memoPubY)
            signer.storage.save(<- key, to: storagePath)
            let cap = signer.capabilities.storage.issue<&{JanusFlow.MemoKeyPublic}>(storagePath)
            signer.capabilities.publish(cap, at: publicPath)
            if let coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm) {
              let memoRegistryAddr = EVM.addressFromString("0x05D104962ff087441f26BA11A1E1C3b9E091D663")
              let calldata = EVM.encodeABIWithSignature("publishMemoKey(uint256,uint256)", [memoPubX, memoPubY])
              let _ = coa.call(to: memoRegistryAddr, data: calldata, gasLimit: 100000, value: EVM.Balance(attoflow: 0))
            }
          }
        }
      `,
      args: (arg, t) => [
        arg(senderKeypair.pubkey.x.toString(), t.UInt256),
        arg(senderKeypair.pubkey.y.toString(), t.UInt256),
      ],
      proposer:       deployerAuthz,
      payer:          deployerAuthz,
      authorizations: [deployerAuthz],
      limit: 9999,
    });
    await fcl.tx(senderMemoTxId).onceSealed();
    ok(`Sender memokey published: ${senderMemoTxId}`);

    // ── A2: Ensure recipient has a Cadence memokey ───────────────────────────
    step("A2", `Check/publish memokey for recipient ${recipientCadence}...`);
    let recipientMemoKey = await getCadenceMemoKey(recipientCadence);
    if (!recipientMemoKey) {
      if (!recipientAuthzFn) throw new Error(`Recipient ${recipientCadence} has no memokey and no authz provided`);
      const recipientKeypair = await generateBabyJubKeypair();
      const recipMemoTxId = await publishCadenceMemoKeyOnly(
        recipientAuthzFn, recipientCadence,
        recipientKeypair.pubkey.x, recipientKeypair.pubkey.y
      );
      ok(`Recipient memokey published: ${recipMemoTxId}`);
      recipientMemoKey = recipientKeypair.pubkey;
    } else {
      ok(`Recipient already has memokey (x=${recipientMemoKey.x.toString().slice(0,8)}...)`);
    }

    // ── B: Mint MockFT to deployer ────────────────────────────────────────────
    // gross = 2.0 MockFT (2_00000000 in raw units, 8 decimals)
    step("B", "Mint 2.0 MockFT to deployer...");
    const GROSS_RAW = 200_000_000n; // 2.0 MockFT in raw units
    const FEE_BPS   = 10n;         // 10 bps = 0.1%
    const FEE_RAW   = (GROSS_RAW * FEE_BPS) / 10000n;
    const NET_RAW   = GROSS_RAW - FEE_RAW;

    const mintTxId = await ftMintToDeployer(bigintToUFix64(GROSS_RAW));
    ok(`Minted ${bigintToUFix64(GROSS_RAW)} MockFT: ${mintTxId}`);

    // ── Step 1: Build wrap proof + submit ────────────────────────────────────
    step("1", `Wrap: gross=${bigintToUFix64(GROSS_RAW)} net=${bigintToUFix64(NET_RAW)}...`);
    const wrapBlinding = generateBlinding();
    const wrapProof    = await buildAmountDiscloseProof(
      { amount: NET_RAW, blinding: wrapBlinding },
      { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
    );
    ok(`AmountDisclose proof built: txCommit.x=${wrapProof.txCommit[0].toString().slice(0,12)}...`);

    const wrapSnapEnc = await encryptSnapshot(
      { balance: NET_RAW, blinding: wrapBlinding, timestampMs: Date.now() },
      senderKeypair.pubkey
    );
    const wrapSnapHex = Buffer.from(wrapSnapEnc.ciphertext).toString("hex");

    const totalLockedBefore = await getFTTotalLocked();

    const wrapTxId = await ftWrap(
      bigintToUFix64(GROSS_RAW), bigintToUFix64(NET_RAW),
      wrapProof.txCommit[0], wrapProof.txCommit[1],
      wrapProof.proof, wrapProof.publicInputs,
      wrapSnapHex,
      wrapSnapEnc.ephemeralPubkey.x, wrapSnapEnc.ephemeralPubkey.y
    );
    ok(`Wrap tx: ${wrapTxId}`);

    // ── Step 2: Verify commitment ─────────────────────────────────────────────
    step("2", "Verify on-chain commitment...");
    const commitAfterWrap = await getFTCommitment(DEPLOYER_CADENCE);
    const totalLockedAfterWrap = await getFTTotalLocked();

    if (isIdentity(commitAfterWrap))
      throw new Error("Commitment still identity after wrap — tx may have silently failed");
    if (totalLockedAfterWrap <= totalLockedBefore)
      throw new Error(`totalLocked did not increase: ${totalLockedBefore} → ${totalLockedAfterWrap}`);
    ok(`totalLocked increased: ${totalLockedBefore} → ${totalLockedAfterWrap}`);

    const localCommit = await computeCommitment(NET_RAW, wrapBlinding);
    if (!commitEq(commitAfterWrap, localCommit)) {
      throw new Error(
        `COMMITMENT MISMATCH — local=(${localCommit.x.toString().slice(0,12)},...) ` +
        `chain=(${commitAfterWrap.x.toString().slice(0,12)},...)`
      );
    }
    ok(`Local commitment matches on-chain (cryptographic consistency verified)`);

    // ── Step 3: Shielded transfer half to recipient ───────────────────────────
    const transferAmount = NET_RAW / 2n;
    step("3", `Shielded transfer ${bigintToUFix64(transferAmount)} to ${recipientCadence}...`);

    const transferBlinding = generateBlinding();
    const newBlinding      = generateBlinding();

    const ctProof = await buildShieldedTransferProof(
      {
        oldBalance:      NET_RAW,
        oldBlinding:     wrapBlinding,
        transferAmount,
        transferBlinding,
        newBlinding,
      },
      { wasmPath: CT_WASM, zkeyPath: CT_ZKEY }
    );
    ok(`ConfidentialTransfer proof built`);

    if (ctProof.publicInputs[0] !== commitAfterWrap.x || ctProof.publicInputs[1] !== commitAfterWrap.y) {
      throw new Error(`C_old mismatch before ST submission`);
    }
    ok(`C_old matches on-chain commitment — proof will pass`);

    const newBalance  = NET_RAW - transferAmount;
    const stSnapEnc   = await encryptSnapshot(
      { balance: newBalance, blinding: newBlinding, timestampMs: Date.now() },
      senderKeypair.pubkey
    );
    const recipNoteEnc = await encryptNote(
      { amount: transferAmount, blinding: transferBlinding },
      recipientMemoKey
    );

    const recipCommitBefore = await getFTCommitment(recipientCadence);

    const stTxId = await ftShieldedTransfer(
      DEPLOYER_CADENCE, recipientCadence,
      ctProof.proof, ctProof.publicInputs,
      Buffer.from(stSnapEnc.ciphertext).toString("hex"),
      stSnapEnc.ephemeralPubkey.x, stSnapEnc.ephemeralPubkey.y,
      Buffer.from(recipNoteEnc.ciphertext).toString("hex"),
      recipNoteEnc.ephemeralPubkey.x, recipNoteEnc.ephemeralPubkey.y,
    );
    ok(`ShieldedTransfer tx: ${stTxId}`);

    // ── Step 4: Verify both commitments updated ───────────────────────────────
    step("4", "Verify commitments updated after shielded transfer...");
    const senderCommitAfterST = await getFTCommitment(DEPLOYER_CADENCE);
    const recipCommitAfterST  = await getFTCommitment(recipientCadence);
    if (isIdentity(senderCommitAfterST))
      throw new Error("Sender commitment is identity after ST");
    if (commitEq(recipCommitAfterST, recipCommitBefore))
      throw new Error("Recipient commitment did not change after ST");
    ok(`Sender commit changed, recipient commit updated (non-identity)`);

    // ── Step 5: Unwrap sender's remaining balance → sender's own vault ────────
    step("5", `Unwrap remaining ${bigintToUFix64(newBalance)} to deployer vault...`);

    const unwrapBlinding2 = generateBlinding();
    const unwrapAdProof   = await buildAmountDiscloseProof(
      { amount: newBalance, blinding: unwrapBlinding2 },
      { wasmPath: AMOUNT_WASM, zkeyPath: AMOUNT_ZKEY }
    );

    const unwrapBlinding3 = generateBlinding();
    const unwrapCtProof   = await buildShieldedTransferProof(
      {
        oldBalance:      newBalance,
        oldBlinding:     newBlinding,
        transferAmount:  newBalance,
        transferBlinding: unwrapBlinding2,
        newBlinding:     unwrapBlinding3,
      },
      { wasmPath: CT_WASM, zkeyPath: CT_ZKEY }
    );

    if (unwrapCtProof.publicInputs[0] !== senderCommitAfterST.x ||
        unwrapCtProof.publicInputs[1] !== senderCommitAfterST.y) {
      throw new Error("Unwrap C_old mismatch");
    }
    if (unwrapAdProof.txCommit[0] !== unwrapCtProof.publicInputs[2] ||
        unwrapAdProof.txCommit[1] !== unwrapCtProof.publicInputs[3]) {
      throw new Error("Unwrap C_tx mismatch between amount-disclose and confidential-transfer");
    }
    ok(`Unwrap proof consistency verified (C_old and C_tx match)`);

    const unwrapSnapEnc = await encryptSnapshot(
      { balance: 0n, blinding: unwrapBlinding3, timestampMs: Date.now() },
      senderKeypair.pubkey
    );

    const totalLockedBeforeUnwrap = await getFTTotalLocked();

    const unwrapTxId = await ftUnwrap(
      DEPLOYER_CADENCE, DEPLOYER_CADENCE,
      bigintToUFix64(newBalance),
      unwrapAdProof.txCommit[0], unwrapAdProof.txCommit[1],
      unwrapAdProof.proof, unwrapAdProof.publicInputs,
      unwrapCtProof.proof, unwrapCtProof.publicInputs,
      Buffer.from(unwrapSnapEnc.ciphertext).toString("hex"),
      unwrapSnapEnc.ephemeralPubkey.x, unwrapSnapEnc.ephemeralPubkey.y,
    );
    ok(`Unwrap tx: ${unwrapTxId}`);

    // ── Step 6: Verify totalLocked decremented ────────────────────────────────
    step("6", "Verify totalLocked decremented after unwrap...");
    const totalLockedAfterUnwrap = await getFTTotalLocked();
    const expectedLocked = totalLockedBeforeUnwrap - newBalance;
    if (totalLockedAfterUnwrap !== expectedLocked) {
      throw new Error(
        `totalLocked mismatch: expected ${expectedLocked}, got ${totalLockedAfterUnwrap}`
      );
    }
    ok(`totalLocked: ${totalLockedBeforeUnwrap} → ${totalLockedAfterUnwrap} (decremented by ${newBalance})`);

    console.log(`\n  PASS: ${testName}`);
    testResults.push({
      name: testName, passed: true,
      transferAmount: transferAmount.toString(),
      wrapTxId, stTxId, unwrapTxId,
    });
  } catch (err) {
    console.error(`\n  FAIL: ${testName}: ${err.message}`);
    testResults.push({ name: testName, passed: false, error: err.message });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== v0.6.6 E2E Multi-Token Test Suite (6/6) ===");
  console.log(`JanusFlow proxy:   ${JF_PROXY}`);
  console.log(`JanusERC20 proxy:  ${ERC20_PROXY}`);
  console.log(`MockUSDC:          ${MOCKUSDC}`);
  console.log(`MemoKeyRegistry:   ${REGISTRY}`);
  console.log(`JanusFT (MockFT):  ${JANUFT_ADDR}`);
  console.log(`Started:           ${new Date().toISOString()}\n`);

  // Verify circuit files exist
  for (const f of [AMOUNT_WASM, AMOUNT_ZKEY, CT_WASM, CT_ZKEY]) {
    if (!existsSync(f)) throw new Error(`Circuit file not found: ${f}`);
  }
  console.log("Circuit files verified.");

  // ── Run 4 test cases ──────────────────────────────────────────────────────
  // Test 1: JanusFlow → EVM-only sim
  await runSingleTest(
    "JanusFlow → EVM-only-sim",
    "flow", "bob", BOB_COA_EVM, EVM_SIM_ADDR, "EVM-only-sim"
  );

  // Test 2: JanusFlow → Cadence+COA sim
  await runSingleTest(
    "JanusFlow → CadenceCOA-sim",
    "flow", "bob", BOB_COA_EVM, CADENCE_SIM_COA, "CadenceCOA-sim"
  );

  // Test 3: JanusERC20(MockUSDC) → EVM-only sim
  await runSingleTest(
    "JanusERC20(MockUSDC) → EVM-only-sim",
    "erc20", "dave", DAVE_COA_EVM, EVM_SIM_ADDR, "EVM-only-sim"
  );

  // Test 4: JanusERC20(MockUSDC) → Cadence+COA sim
  await runSingleTest(
    "JanusERC20(MockUSDC) → CadenceCOA-sim",
    "erc20", "dave", DAVE_COA_EVM, CADENCE_SIM_COA, "CadenceCOA-sim"
  );

  // ── MockFT (cadence-ft) tests — Tests 5 + 6 ───────────────────────────────
  //
  // JanusFT is Cadence-native: commitments are keyed by Cadence address.
  // Sender = deployer (has CommitmentRegistry + COA + Minter).
  // Recipients are Cadence accounts with /public/openjanusMemoKey.
  //
  // Test 5: sender → charlie (existing Cadence memokey)
  //   charlie already has /public/openjanusMemoKey published + MockFT receiver.
  //   recipientAuthzFn = null (no memokey setup needed).
  //
  // Test 6: sender → eve (fresh Cadence memokey published in setup)
  //   eve needs a memokey published via her P256 key (eveAuthz).
  //   We pass eveAuthz so the test can publish it during the A2 step.
  //
  // For both tests:
  //   - Deployer mints 2.0 MockFT, wraps with real AmountDisclose proof
  //   - Transfers 1.0 MockFT to recipient via real ConfidentialTransfer proof
  //   - Deployer unwraps remaining 1.0 MockFT back to vault
  //   - All ZK verifications cross-VM through deployer's COA

  await runMockFTTest(
    "JanusFT(MockFT) → charlie (Cadence-native recipient)",
    CHARLIE_CADENCE,
    null  // charlie already has memokey
  );

  await runMockFTTest(
    "JanusFT(MockFT) → eve (fresh Cadence memokey)",
    EVE_CADENCE,
    eveAuthz  // eve needs memokey published first
  );

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(64)}`);
  console.log("E2E RESULTS:");
  console.log(`${"=".repeat(64)}`);
  const passed = testResults.filter(r => r.passed).length;
  const failed = testResults.filter(r => !r.passed).length;
  for (const r of testResults) {
    const status = r.passed ? "PASS" : "FAIL";
    console.log(`  ${status} — ${r.name}${r.error ? `: ${r.error.slice(0, 150)}` : ""}`);
  }
  console.log(`\n  Total: ${passed} passed / ${failed} failed`);
  console.log(`  Finished: ${new Date().toISOString()}`);

  // Save results for handoff doc
  writeFileSync(
    "/tmp/e2e-results-v066.json",
    JSON.stringify({ timestamp: new Date().toISOString(), tests: testResults }, null, 2)
  );

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed — see errors above`);
    process.exit(1);
  }
  console.log(`\n  All tests passed.`);
}

main().catch(err => {
  console.error("\nFATAL:", err.message);
  if (err.stack) console.error(err.stack.slice(0, 500));
  process.exit(1);
});
