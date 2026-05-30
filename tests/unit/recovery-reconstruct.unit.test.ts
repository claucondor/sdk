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
