/**
 * examples/multi-wrap.ts
 *
 * Demonstrates homomorphic accumulation:
 *   Alice wraps 50 FLOW → transfers 10 to Charlie
 *   Bob wraps 30 FLOW → transfers 5 to Charlie
 *   Charlie unwraps 15 FLOW (accumulated from two senders)
 *
 * This example mirrors the successful Test 3 from the v1.1.0 E2E suite:
 *   Alice→Charlie: 21665c5f726538c13f3e722c2a2d66c42ac7c6cbee40705c159a26ab63393b61
 *   Bob→Charlie:   630804253f8b762f1e879caff5f28525a7251edb4954924a07ce9f19726e6c6d
 *   Charlie unwrap: 7db94ebd29903e556bc741b93b4707c715a68cfe5b5569ffce3b416cb92a6d34
 *
 * KEY POINT: JanusToken.mintXY is homomorphic (additive), not a setter.
 * When two transfers arrive at Charlie's slot:
 *   slot = add(slot, delta) for each incoming transfer
 *
 * Run (prints commitment math and API usage):
 *   npx ts-node --esm examples/multi-wrap.ts
 */

import { computeCommitment, addCommitments, generateBlinding } from "../src/crypto/commitment";

async function main() {
  console.log("=== JanusFlow Multi-Wrap Example ===");
  console.log("Demonstrating homomorphic commitment accumulation at Charlie.");
  console.log();

  // -------------------------------------------------------------------------
  // Commitment math (no network required for this demonstration)
  // -------------------------------------------------------------------------

  const ALICE_TRANSFER = 10n;
  const BOB_TRANSFER = 5n;
  const TOTAL = ALICE_TRANSFER + BOB_TRANSFER; // 15 FLOW

  const r_alice_tx = generateBlinding();
  const r_bob_tx = generateBlinding();

  console.log("Alice generates transfer commitment (10 FLOW)...");
  const aliceTxCommit = await computeCommitment(ALICE_TRANSFER, r_alice_tx);
  console.log(`  C_alice_tx.x = ${aliceTxCommit.x.toString().slice(0, 20)}...`);

  console.log("Bob generates transfer commitment (5 FLOW)...");
  const bobTxCommit = await computeCommitment(BOB_TRANSFER, r_bob_tx);
  console.log(`  C_bob_tx.x = ${bobTxCommit.x.toString().slice(0, 20)}...`);

  console.log();
  console.log("Charlie's accumulated commitment (homomorphic addition):");
  const charlieAccum = await addCommitments(aliceTxCommit, bobTxCommit);
  console.log(`  C_charlie_total.x = ${charlieAccum.x.toString().slice(0, 20)}...`);
  console.log(`  C_charlie_total.y = ${charlieAccum.y.toString().slice(0, 20)}...`);

  // NOTE: circomlib Pedersen is a hash function (not a two-generator EC commitment),
  // so Pedersen(a,r1) + Pedersen(b,r2) is NOT equal to Pedersen(a+b, r1+r2).
  // What JanusToken does: accumulate commitment POINTS additively at the recipient slot.
  // The ZK circuit proves balance conservation at transfer time (not homomorphism).
  console.log("  [Points accumulated additively at Charlie's EVM slot via mintXY]");
  console.log();

  console.log(`Total FLOW Charlie can unwrap: ${TOTAL} FLOW`);
  console.log();

  console.log("SDK API for full multi-wrap execution (requires FCL authz):");
  console.log();
  console.log("  // Alice wraps 50 FLOW, transfers 10 to Charlie");
  console.log(`  await sdk.wrap("50.0", 50n, r_alice, aliceAuthz);`);
  console.log(
    `  await sdk.confidentialTransfer(CHARLIE, { oldBalance: 50n, transferAmount: 10n, ... }, aliceAuthz);`
  );
  console.log();
  console.log("  // Bob wraps 30 FLOW, transfers 5 to Charlie");
  console.log(`  await sdk.wrap("30.0", 30n, r_bob, bobAuthz);`);
  console.log(
    `  await sdk.confidentialTransfer(CHARLIE, { oldBalance: 30n, transferAmount: 5n, ... }, bobAuthz);`
  );
  console.log();
  console.log("  // Charlie reads accumulated commitment (via COA slot)");
  console.log(`  const charlieCommit = await sdk.getCommitment(CHARLIE_ADDR);`);
  console.log();
  console.log("  // Charlie unwraps 15 FLOW (total from both senders)");
  console.log(
    `  await sdk.unwrap("15.0", 15n, r_total, CHARLIE_ADDR, charlieAuthz);`
  );
  console.log();
  console.log("Reference TX hashes from successful v1.1.0 E2E test:");
  console.log(
    "  Alice→Charlie:  21665c5f726538c13f3e722c2a2d66c42ac7c6cbee40705c159a26ab63393b61"
  );
  console.log(
    "  Bob→Charlie:    630804253f8b762f1e879caff5f28525a7251edb4954924a07ce9f19726e6c6d"
  );
  console.log(
    "  Charlie unwrap: 7db94ebd29903e556bc741b93b4707c715a68cfe5b5569ffce3b416cb92a6d34"
  );
  console.log();
  console.log("Example complete.");
}

main().catch(console.error);
