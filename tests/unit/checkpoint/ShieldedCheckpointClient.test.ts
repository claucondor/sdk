/**
 * tests/unit/checkpoint/ShieldedCheckpointClient.test.ts
 *
 * Unit tests for ShieldedCheckpointClient v0.8.2 — multi-token per-token API.
 *
 * No network calls — the internal _contract is replaced with a vi.fn() mock
 * (same pattern as BatchClaimClient.test.ts). Tests verify:
 *   1. Contract address defaults to new v0.8.2 deployment
 *   2. exists() passes user + token to contract
 *   3. metadata() passes user + token to contract  
 *   4. read() passes token to staticCall, returns null on NoCheckpoint
 *   5. readAndDecrypt() returns null when read() returns null
 *   6. update() passes token as first arg to contract
 *   7. CheckpointUpdated event parsing (two-indexed: owner + token)
 *   8. Token isolation: FLOW vs mUSDC use different args
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";
import { ShieldedCheckpointClient } from "../../../src/checkpoint/ShieldedCheckpointClient";
import { SHIELDED_CHECKPOINT_ADDRESS } from "../../../src/network/contracts";

const FLOW_TOKEN_PROXY = "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3";
const MUSDC_PROXY      = "0xFD8F82bE1782AF1F85f4673065e94fb3F8D5387d";
const ALICE            = "0xFc47B35f79d26A060B652E112c53d7c6057d05FF";

const FAKE_SNAPSHOT  = new Uint8Array(32).fill(0xab);
const FAKE_EPH_X     = 123456789n;
const FAKE_EPH_Y     = 987654321n;
const FAKE_CURSOR    = 7n;
const FAKE_BLOCK     = 12345678n;
const FAKE_VERSION   = 3n;

const FAKE_PAYLOAD = {
  encryptedSnapshot: FAKE_SNAPSHOT,
  ephPubkeyX:        FAKE_EPH_X,
  ephPubkeyY:        FAKE_EPH_Y,
};

// Build a ShieldedCheckpointClient with a mocked internal _contract.
// Mirrors BatchClaimClient.test.ts: replace (client as any)._contract after construction.
function makeClient(overrides: {
  exists?: ReturnType<typeof vi.fn>;
  metadata?: ReturnType<typeof vi.fn>;
  readStaticCall?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
} = {}) {
  const defaultReadResult = {
    encryptedSnapshot: ethers.hexlify(FAKE_SNAPSHOT),
    ephPubkeyX: FAKE_EPH_X,
    ephPubkeyY: FAKE_EPH_Y,
    lastConsumedNoteIndex: FAKE_CURSOR,
    lastUpdatedBlock: FAKE_BLOCK,
    version: FAKE_VERSION,
  };

  const mockReadFn = overrides.readStaticCall ?? vi.fn().mockResolvedValue(defaultReadResult);
  const mockUpdateFn = overrides.update ?? vi.fn().mockResolvedValue({
    hash: "0xabcdef", wait: vi.fn().mockResolvedValue({ logs: [] }),
  });
  const mockExistsFn = overrides.exists ?? vi.fn().mockResolvedValue(true);
  const mockMetaFn   = overrides.metadata ?? vi.fn().mockResolvedValue([FAKE_CURSOR, FAKE_BLOCK, FAKE_VERSION, true]);

  const mockContract = {
    exists:   mockExistsFn,
    metadata: mockMetaFn,
    read:     { staticCall: mockReadFn },
    update:   mockUpdateFn,
    connect:  vi.fn().mockReturnThis(),
  };

  const client = new ShieldedCheckpointClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any)._contract = mockContract;

  return { client, mockExistsFn, mockMetaFn, mockReadFn, mockUpdateFn };
}

describe("ShieldedCheckpointClient — unit (v0.8.2 multi-token)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe("constructor", () => {
    it("defaults to new v0.8.2 SHIELDED_CHECKPOINT_ADDRESS", () => {
      const client = new ShieldedCheckpointClient();
      expect(client.address).toBe(SHIELDED_CHECKPOINT_ADDRESS);
      expect(client.address).toBe("0x88C9fD443BC15d1Cd24bc724DB6928D3246b2E26");
    });
    it("accepts a custom address override", () => {
      const custom = "0x1234567890123456789012345678901234567890";
      expect(new ShieldedCheckpointClient(custom).address).toBe(custom);
    });
  });

  describe("exists(user, token)", () => {
    it("passes user and token to contract.exists()", async () => {
      const { client, mockExistsFn } = makeClient();
      await client.exists(ALICE, FLOW_TOKEN_PROXY);
      expect(mockExistsFn).toHaveBeenCalledWith(ALICE, FLOW_TOKEN_PROXY);
    });
    it("returns true when contract returns true", async () => {
      const { client } = makeClient({ exists: vi.fn().mockResolvedValue(true) });
      expect(await client.exists(ALICE, FLOW_TOKEN_PROXY)).toBe(true);
    });
    it("returns false for unknown token", async () => {
      const { client } = makeClient({ exists: vi.fn().mockResolvedValue(false) });
      expect(await client.exists(ALICE, MUSDC_PROXY)).toBe(false);
    });
    it("uses different args for FLOW vs mUSDC", async () => {
      const fn = vi.fn().mockResolvedValue(true);
      const { client } = makeClient({ exists: fn });
      await client.exists(ALICE, FLOW_TOKEN_PROXY);
      await client.exists(ALICE, MUSDC_PROXY);
      expect(fn).toHaveBeenNthCalledWith(1, ALICE, FLOW_TOKEN_PROXY);
      expect(fn).toHaveBeenNthCalledWith(2, ALICE, MUSDC_PROXY);
    });
  });

  describe("metadata(user, token)", () => {
    it("passes user and token to contract.metadata()", async () => {
      const { client, mockMetaFn } = makeClient();
      await client.metadata(ALICE, FLOW_TOKEN_PROXY);
      expect(mockMetaFn).toHaveBeenCalledWith(ALICE, FLOW_TOKEN_PROXY);
    });
    it("returns correctly typed CheckpointMetadata", async () => {
      const { client } = makeClient();
      const meta = await client.metadata(ALICE, FLOW_TOKEN_PROXY);
      expect(meta.lastConsumedNoteIndex).toBe(FAKE_CURSOR);
      expect(meta.lastUpdatedBlock).toBe(FAKE_BLOCK);
      expect(meta.version).toBe(FAKE_VERSION);
      expect(meta.hasCheckpoint).toBe(true);
    });
    it("uses different token args for FLOW vs mUSDC", async () => {
      const { client, mockMetaFn } = makeClient();
      await client.metadata(ALICE, FLOW_TOKEN_PROXY);
      await client.metadata(ALICE, MUSDC_PROXY);
      expect(mockMetaFn).toHaveBeenNthCalledWith(1, ALICE, FLOW_TOKEN_PROXY);
      expect(mockMetaFn).toHaveBeenNthCalledWith(2, ALICE, MUSDC_PROXY);
    });
  });

  describe("read(token, signer)", () => {
    it("calls staticCall with token as first arg", async () => {
      const { client, mockReadFn } = makeClient();
      const signer = { address: ALICE } as ethers.Wallet;
      await client.read(FLOW_TOKEN_PROXY, signer);
      expect(mockReadFn).toHaveBeenCalledWith(FLOW_TOKEN_PROXY);
    });
    it("returns RawCheckpoint with correct bigint types", async () => {
      const { client } = makeClient();
      const signer = { address: ALICE } as ethers.Wallet;
      const raw = await client.read(FLOW_TOKEN_PROXY, signer);
      expect(raw).not.toBeNull();
      expect(raw!.ephPubkeyX).toBe(FAKE_EPH_X);
      expect(raw!.ephPubkeyY).toBe(FAKE_EPH_Y);
      expect(raw!.lastConsumedNoteIndex).toBe(FAKE_CURSOR);
      expect(raw!.version).toBe(FAKE_VERSION);
    });
    it("returns null when NoCheckpoint error is thrown", async () => {
      const err = new Error("NoCheckpoint(address,address)");
      const { client } = makeClient({ readStaticCall: vi.fn().mockRejectedValue(err) });
      const signer = { address: ALICE } as ethers.Wallet;
      expect(await client.read(FLOW_TOKEN_PROXY, signer)).toBeNull();
    });
    it("re-throws non-NoCheckpoint errors", async () => {
      const err = new Error("EVM: out of gas");
      const { client } = makeClient({ readStaticCall: vi.fn().mockRejectedValue(err) });
      const signer = { address: ALICE } as ethers.Wallet;
      await expect(client.read(FLOW_TOKEN_PROXY, signer)).rejects.toThrow("EVM: out of gas");
    });
  });

  describe("readAndDecrypt(token, signer, memoPrivKey)", () => {
    it("returns null when read() returns null (no checkpoint)", async () => {
      const err = new Error("NoCheckpoint");
      const { client } = makeClient({ readStaticCall: vi.fn().mockRejectedValue(err) });
      const signer = { address: ALICE } as ethers.Wallet;
      expect(await client.readAndDecrypt(FLOW_TOKEN_PROXY, signer, 12345n)).toBeNull();
    });
  });

  describe("update(token, payload, cursor, signer)", () => {
    it("passes token as first argument to contract.update()", async () => {
      const mockFn = vi.fn().mockResolvedValue({ hash: "0xdeadbeef", wait: vi.fn().mockResolvedValue({ logs: [] }) });
      const { client } = makeClient({ update: mockFn });
      const signer = { address: ALICE } as ethers.Wallet;
      const result = await client.update(FLOW_TOKEN_PROXY, FAKE_PAYLOAD, FAKE_CURSOR, signer);
      expect(mockFn.mock.calls[0]![0]).toBe(FLOW_TOKEN_PROXY);
      expect(result.txHash).toBe("0xdeadbeef");
    });
    it("passes MUSDC proxy as token for mUSDC checkpoints", async () => {
      const mockFn = vi.fn().mockResolvedValue({ hash: "0xabcd", wait: vi.fn().mockResolvedValue({ logs: [] }) });
      const { client } = makeClient({ update: mockFn });
      const signer = { address: ALICE } as ethers.Wallet;
      await client.update(MUSDC_PROXY, FAKE_PAYLOAD, 0n, signer);
      expect(mockFn.mock.calls[0]![0]).toBe(MUSDC_PROXY);
    });
    it("FLOW and mUSDC updates use different first args", async () => {
      const mockFn = vi.fn().mockResolvedValue({ hash: "0xabc", wait: vi.fn().mockResolvedValue({ logs: [] }) });
      const { client } = makeClient({ update: mockFn });
      const signer = { address: ALICE } as ethers.Wallet;
      await client.update(FLOW_TOKEN_PROXY, FAKE_PAYLOAD, 5n, signer);
      await client.update(MUSDC_PROXY, FAKE_PAYLOAD, 5n, signer);
      expect(mockFn.mock.calls[0]![0]).toBe(FLOW_TOKEN_PROXY);
      expect(mockFn.mock.calls[1]![0]).toBe(MUSDC_PROXY);
    });
    it("parses version from two-indexed CheckpointUpdated event", async () => {
      const iface = new ethers.Interface([
        "event CheckpointUpdated(address indexed owner, address indexed token, uint64 version, uint64 lastConsumedNoteIndex, uint64 blockNumber)",
      ]);
      const log = iface.encodeEventLog("CheckpointUpdated", [ALICE, FLOW_TOKEN_PROXY, 5, 7, 12345678]);
      const mockFn = vi.fn().mockResolvedValue({
        hash: "0xabc",
        wait: vi.fn().mockResolvedValue({ logs: [{ topics: log.topics, data: log.data }] }),
      });
      const { client } = makeClient({ update: mockFn });
      const signer = { address: ALICE } as ethers.Wallet;
      const result = await client.update(FLOW_TOKEN_PROXY, FAKE_PAYLOAD, FAKE_CURSOR, signer);
      expect(result.version).toBe(5n);
    });
  });

  describe("token isolation", () => {
    it("FLOW and mUSDC exist() calls use different second args", async () => {
      let callCount = 0;
      const { client } = makeClient({
        exists: vi.fn().mockImplementation(() => Promise.resolve(callCount++ === 0)),
      });
      expect(await client.exists(ALICE, FLOW_TOKEN_PROXY)).toBe(true);
      expect(await client.exists(ALICE, MUSDC_PROXY)).toBe(false);
    });
    it("metadata() can return different versions for different tokens", async () => {
      let callCount = 0;
      const { client } = makeClient({
        metadata: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve(callCount === 1 ? [5n, 12345678n, 3n, true] : [2n, 12345679n, 1n, true]);
        }),
      });
      const flowMeta = await client.metadata(ALICE, FLOW_TOKEN_PROXY);
      const usdcMeta = await client.metadata(ALICE, MUSDC_PROXY);
      expect(flowMeta.version).toBe(3n);
      expect(usdcMeta.version).toBe(1n);
    });
  });
});
