/**
 * Unit tests for recovery/reconstruct.ts — state reconstruction algorithm.
 *
 * These tests mock the on-chain commitment validation so no network is needed.
 * The actual validatePedersenCommit is tested via integration tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconstructFromSnapshots } from "../../src/recovery/reconstruct";
import { RecoveryDesyncError } from "../../src/recovery/types";
import type { Snapshot, IncomingDelta } from "../../src/recovery/types";

// We mock validate.ts so we can control whether validation passes or fails
// without real Pedersen computation (that's covered in pedersen.unit.test.ts).
vi.mock("../../src/recovery/validate", () => ({
  validatePedersenCommit: vi.fn(),
  readJanusFlowCommitment: vi.fn(),
  JANUS_FLOW_DEFAULT_ADDR: "0x09A3DCa868EcC39360fDe4E22046eCfcbA5b4078",
}));

import { validatePedersenCommit } from "../../src/recovery/validate";

const mockValidate = vi.mocked(validatePedersenCommit);

const DUMMY_COMMIT = { x: 1n, y: 2n };

describe("reconstructFromSnapshots — snapshot-only case", () => {
  beforeEach(() => {
    mockValidate.mockResolvedValue(true);
  });

  it("returns the latest snapshot when there are multiple", async () => {
    const snapshots: Snapshot[] = [
      { balance: 100n, blinding: 10n, timestamp: 1000 },
      { balance: 200n, blinding: 20n, timestamp: 2000 },
      { balance: 150n, blinding: 15n, timestamp: 1500 }, // out of order
    ];

    const result = await reconstructFromSnapshots({
      snapshots,
      incomingDeltas: [],
      onChainCommit: DUMMY_COMMIT,
    });

    // Latest by timestamp is the one at ts=2000
    expect(result.balanceWei).toBe(200n);
    expect(result.blinding).toBe(20n);
  });

  it("returns zero state when no snapshots and no deltas", async () => {
    const result = await reconstructFromSnapshots({
      snapshots: [],
      incomingDeltas: [],
      onChainCommit: DUMMY_COMMIT,
    });

    expect(result.balanceWei).toBe(0n);
    expect(result.blinding).toBe(0n);
  });
});

describe("reconstructFromSnapshots — snapshot + incoming deltas", () => {
  beforeEach(() => {
    mockValidate.mockResolvedValue(true);
  });

  it("adds deltas that arrive after the latest snapshot", async () => {
    const snapshots: Snapshot[] = [
      { balance: 500n, blinding: 50n, timestamp: 1000 },
    ];
    const deltas: IncomingDelta[] = [
      { amount: 100n, blinding: 10n, timestamp: 2000 }, // after snapshot
      { amount: 200n, blinding: 20n, timestamp: 500 },  // before snapshot — ignored
    ];

    const result = await reconstructFromSnapshots({
      snapshots,
      incomingDeltas: deltas,
      onChainCommit: DUMMY_COMMIT,
    });

    // Only the delta at ts=2000 is included
    expect(result.balanceWei).toBe(600n);    // 500 + 100
    expect(result.blinding).toBe(60n);       // 50 + 10
  });

  it("ignores deltas at exactly the snapshot timestamp (not strictly after)", async () => {
    const snapshots: Snapshot[] = [
      { balance: 300n, blinding: 30n, timestamp: 1000 },
    ];
    const deltas: IncomingDelta[] = [
      { amount: 100n, blinding: 10n, timestamp: 1000 }, // same timestamp — ignored
    ];

    const result = await reconstructFromSnapshots({
      snapshots,
      incomingDeltas: deltas,
      onChainCommit: DUMMY_COMMIT,
    });

    expect(result.balanceWei).toBe(300n);
    expect(result.blinding).toBe(30n);
  });
});

describe("reconstructFromSnapshots — validation failure", () => {
  it("throws RecoveryDesyncError when Pedersen validation fails", async () => {
    mockValidate.mockResolvedValue(false);

    const snapshots: Snapshot[] = [
      { balance: 100n, blinding: 10n, timestamp: 1000 },
    ];

    await expect(
      reconstructFromSnapshots({
        snapshots,
        incomingDeltas: [],
        onChainCommit: DUMMY_COMMIT,
      })
    ).rejects.toThrow(RecoveryDesyncError);
  });

  it("RecoveryDesyncError message mentions reconstructed values", async () => {
    mockValidate.mockResolvedValue(false);

    const snapshots: Snapshot[] = [
      { balance: 42n, blinding: 7n, timestamp: 1000 },
    ];

    let thrown: unknown;
    try {
      await reconstructFromSnapshots({
        snapshots,
        incomingDeltas: [],
        onChainCommit: DUMMY_COMMIT,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(RecoveryDesyncError);
    expect((thrown as RecoveryDesyncError).message).toContain("42");
  });
});

// ---------------------------------------------------------------------------
// Bug regression: receive → partial unwrap → recover (timestamp unit mismatch)
// ---------------------------------------------------------------------------
// Before the fix in scanner.ts, `RawSnapshot.timestamp` held an EVM block
// number (e.g. 113_217_688) rather than a Unix epoch second (e.g. 1_700_000_000).
// Because any EVM block number is numerically larger than any reasonable Unix
// timestamp, the comparison `delta.timestamp > base.timestamp` in
// reconstructFromSnapshots was always true for incoming deltas — causing
// double-counting whenever a tip was received *before* a subsequent self-op.
//
// This describe block exercises the corrected ordering using timestamps that
// are all in Unix epoch seconds (as they would be after the scanner.ts fix).
describe("reconstructFromSnapshots — receive → partial unwrap → recover (regression)", () => {
  beforeEach(() => {
    mockValidate.mockResolvedValue(true);
  });

  it("receive → partial unwrap → recover should return correct balance", async () => {
    // Scenario:
    //   1. User receives 10 FLOW from another user at Unix ts 1_700_000_000
    //      (incoming delta, NOT a self-snapshot).
    //   2. User unwraps 5 FLOW at Unix ts 1_700_001_000, emitting a self-snapshot
    //      with balance=5 FLOW (i.e. the snapshot already accounts for the tip).
    //
    // Expected recovery result: 5 FLOW — the snapshot is the ground truth and
    // the incoming delta is older, so it must NOT be re-added.

    const FLOW = 10n ** 18n; // 1 FLOW in Wei

    const incomingDeltas: IncomingDelta[] = [
      {
        amount: 10n * FLOW,   // received 10 FLOW
        blinding: 123n,
        timestamp: 1_700_000_000, // tip received first (Unix seconds)
      },
    ];

    const snapshots: Snapshot[] = [
      {
        balance: 5n * FLOW,   // unwrap snapshot: balance after receiving + unwrapping
        blinding: 456n,
        timestamp: 1_700_001_000, // unwrap happened later (Unix seconds)
      },
    ];

    // The snapshot is LATER than the delta, so delta must be ignored.
    const result = await reconstructFromSnapshots({
      snapshots,
      incomingDeltas,
      onChainCommit: DUMMY_COMMIT,
    });

    expect(result.balanceWei).toBe(5n * FLOW);
    expect(result.blinding).toBe(456n);
  });

  it("receive after unwrap → delta IS included (delta newer than snapshot)", async () => {
    // Scenario:
    //   1. User wraps 5 FLOW at ts 1_700_000_000 (self-snapshot).
    //   2. User receives 10 FLOW tip at ts 1_700_001_000 (incoming delta, newer).
    //
    // Expected: 15 FLOW — the delta is newer than the snapshot, must be added.

    const FLOW = 10n ** 18n;

    const snapshots: Snapshot[] = [
      {
        balance: 5n * FLOW,
        blinding: 100n,
        timestamp: 1_700_000_000,
      },
    ];

    const incomingDeltas: IncomingDelta[] = [
      {
        amount: 10n * FLOW,
        blinding: 200n,
        timestamp: 1_700_001_000, // newer than snapshot → must be included
      },
    ];

    const result = await reconstructFromSnapshots({
      snapshots,
      incomingDeltas,
      onChainCommit: DUMMY_COMMIT,
    });

    expect(result.balanceWei).toBe(15n * FLOW); // 5 + 10
    expect(result.blinding).toBe(300n);          // 100 + 200
  });
});
