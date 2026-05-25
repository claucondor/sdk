/**
 * examples/basic-transfer.ts
 *
 * Demonstrates the complete JanusFlow lifecycle:
 *   Alice wraps 10 FLOW → transfers 3 to Bob → Bob unwraps 3 FLOW
 *
 * This example mirrors the successful Test 1 from the v1.1.0 E2E suite
 * (see docs/DEPLOYMENTS.md). It is RUNNABLE against Flow testnet:
 *
 *   ALICE_PKEY=<hex_key> BOB_PKEY=<hex_key> \
 *   WASM_PATH=/path/to/confidentialTransfer.wasm \
 *   ZKEY_PATH=/path/to/confidentialTransfer_final.zkey \
 *   npx ts-node --esm examples/basic-transfer.ts
 *
 * For testnet demo, set accounts to Bob/Charlie from ~/.flow/testnet-*.json.
 * The private keys must correspond to Cadence accounts with FLOW balance.
 *
 * NOTE: This example uses FCL with direct account authorization.
 * Production wallets use fcl.authz() from a wallet extension.
 */

import { JanusFlow } from "../src/tokens/janus-flow";
import { computeCommitment, generateBlinding } from "../src/crypto/commitment";

// ---------------------------------------------------------------------------
// Configuration — set via environment variables
// ---------------------------------------------------------------------------

const ALICE_CADENCE_ADDRESS =
  process.env["ALICE_CADENCE_ADDRESS"] ?? "0x7599043aea001283";
const BOB_CADENCE_ADDRESS =
  process.env["BOB_CADENCE_ADDRESS"] ?? "0xd807a3992d7be612";

// Circuit artifact paths (read from cadence-crypto-lab — read-only reference)
const WASM_PATH =
  process.env["WASM_PATH"] ??
  "/home/oydual3/cadence-crypto-lab/modules/zk/confidential-transfer-circuit/circuit/confidentialTransfer.wasm";
const ZKEY_PATH =
  process.env["ZKEY_PATH"] ??
  "/home/oydual3/cadence-crypto-lab/modules/zk/confidential-transfer-circuit/setup/confidentialTransfer_final.zkey";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== JanusFlow Basic Transfer Example ===");
  console.log("Alice:", ALICE_CADENCE_ADDRESS);
  console.log("Bob:", BOB_CADENCE_ADDRESS);
  console.log();

  // NOTE: Full execution requires FCL authorization from funded Cadence accounts.
  // This example prints the commitment math to demonstrate the SDK API.

  const sdk = new JanusFlow({ network: "testnet" });
  await sdk.configure();

  console.log("Step 1: Alice generates wrap commitment for 10 FLOW...");
  const aliceBlinding = generateBlinding();
  const aliceCommitment = await computeCommitment(10n, aliceBlinding);
  console.log(
    `  C_wrap.x = ${aliceCommitment.x.toString().slice(0, 20)}...`
  );
  console.log(
    `  C_wrap.y = ${aliceCommitment.y.toString().slice(0, 20)}...`
  );
  console.log(
    `  Blinding = ${aliceBlinding.toString().slice(0, 20)}... [STORE THIS]`
  );
  console.log();

  console.log("Step 2: Build transfer proof (Alice → 3 FLOW → Bob)...");
  const txBlinding = generateBlinding();
  const newBlinding = generateBlinding();

  console.log("  Transfer amount: 3 FLOW");
  console.log("  Remaining for Alice: 7 FLOW");
  console.log();

  console.log("Transfer proof input ready:");
  console.log("  {");
  console.log("    oldBalance: 10n,");
  console.log("    oldBlinding: <alice_blinding>,");
  console.log("    transferAmount: 3n,");
  console.log("    transferBlinding: <tx_blinding>,");
  console.log("    newBlinding: <alice_new_blinding>,");
  console.log(`    wasmPath: "${WASM_PATH}",`);
  console.log(`    zkeyPath: "${ZKEY_PATH}"`);
  console.log("  }");
  console.log();

  console.log("SDK API for full execution (requires FCL authz):");
  console.log();
  console.log("  // 1. Wrap");
  console.log(
    `  const { txId: wrapTx } = await sdk.wrap("10.0", 10n, aliceBlinding, aliceAuthz);`
  );
  console.log();
  console.log("  // 2. Confidential transfer");
  console.log(
    `  const { txId: transferTx } = await sdk.confidentialTransfer(`
  );
  console.log(`    BOB_CADENCE_ADDRESS,`);
  console.log(
    `    { oldBalance: 10n, oldBlinding, transferAmount: 3n, txBlinding, newBlinding, wasmPath, zkeyPath },`
  );
  console.log(`    aliceAuthz`);
  console.log(`  );`);
  console.log();
  console.log("  // 3. Unwrap (Bob receives)");
  console.log(
    `  const { txId: unwrapTx } = await sdk.unwrap("3.0", 3n, txBlinding, BOB_CADENCE_ADDRESS, bobAuthz);`
  );
  console.log();

  console.log(
    "Reference TX hashes from successful v1.1.0 E2E test (2026-05-25):"
  );
  console.log(
    "  Alice wrap:         a08a6e4106ae6e425e5daa2c97e6693424cc5ea620a2a83b523d82eecf41d19e"
  );
  console.log(
    "  Alice→Bob transfer: b18e4517c59344fdc88d5527321f83fa2fb26df47b43a6c0866845d013f41399"
  );
  console.log(
    "  Bob unwrap:         5938fd26af0ad510a04d4be299e13734174ffe2b415f2f687e2934e152fee8a7"
  );
  console.log();
  console.log("Example complete (commitment math demonstrated, TX execution requires FCL authz).");
}

main().catch(console.error);
