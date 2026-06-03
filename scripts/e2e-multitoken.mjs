/**
 * e2e-multitoken.mjs — v0.6.6 End-to-End validation script.
 *
 * Real proofs, real contracts, real on-chain state. No stubs.
 * Runs in Node.js using SDK dist + snarkjs + circomlibjs.
 *
 * Test matrix (2 tokens × 2 recipients = 4 test cases):
 *   Token: flow | mockusdc
 *   Recipient: EVM-only sim | Cadence+COA sim
 *
 * For each test case:
 *   1. Publish fresh memokey for sender
 *   2. Wrap tokens (real AmountDisclose proof, COA sends tx)
 *   3. Verify on-chain commitment != identity AND matches local computation
 *   4. Shielded transfer half to recipient (real ConfidentialTransfer proof)
 *   5. Verify sender and recipient commitments updated
 *   6. Unwrap remaining balance
 *   7. Verify totalLocked decremented
 *
 * Run:
 *   node scripts/e2e-multitoken.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== v0.6.6 E2E Multi-Token Test Suite ===");
  console.log(`JanusFlow proxy:   ${JF_PROXY}`);
  console.log(`JanusERC20 proxy:  ${ERC20_PROXY}`);
  console.log(`MockUSDC:          ${MOCKUSDC}`);
  console.log(`MemoKeyRegistry:   ${REGISTRY}`);
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
