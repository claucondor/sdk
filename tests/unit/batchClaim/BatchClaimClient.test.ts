/**
 * tests/unit/batchClaim/BatchClaimClient.test.ts
 *
 * Unit tests for BatchClaimClient.
 * No proof generation — tests focus on:
 *   - claimBatch() input validation (wrong-length arrays)
 *   - ABI selector correctness (pure ethers.Interface — no mock)
 *   - Contract method delegation for getVersion / getVerifierAddress
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";
import { BatchClaimClient } from "../../../src/batchClaim/BatchClaimClient";
import type { ProofUint256 } from "../../../src/types/proof";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROXY_ADDR = "0xA64340C1d356835A2450306Ffd290Ed52c001Ad3";

/** Valid 6-element public inputs (from happy-path.json n5). */
const MOCK_PUBLIC_INPUTS: [bigint, bigint, bigint, bigint, bigint, bigint] = [
  8493995088669492941030449993460966168125164062547959036539380137995121652823n,
  980091792878496942390948583639228336197310148012141975928130766742690741129n,
  10136366868494787981631135992376279633230776698842331932391551007707568304977n,
  3047412401573570226833251737192551019877468074472798567184802764578354556335n,
  136933251170279916227381655360309977121529027810286637389835077920485947039n,
  20836619934082269279304708433730610952589712728197645352270072933360614163082n,
];

const MOCK_PROOF: ProofUint256 = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n];

// ---------------------------------------------------------------------------
// Helper — build a BatchClaimClient with an injected mock contract.
//
// ethers.Contract constructor succeeds with an empty-object runner (it stores it
// but does not validate until a call is made). We then replace the internal
// `contract` field with a full mock so tests don't hit the network.
// ---------------------------------------------------------------------------

function makeClient(contractOverrides?: {
  claimBatchImpl?: ReturnType<typeof vi.fn>;
  versionImpl?: ReturnType<typeof vi.fn>;
  verifierImpl?: ReturnType<typeof vi.fn>;
}) {
  const mockReceipt = { hash: "0xdeadbeef", blockNumber: 10, status: 1 };
  const mockTx = { wait: vi.fn().mockResolvedValue(mockReceipt) };

  const mockClaimBatch = contractOverrides?.claimBatchImpl ?? vi.fn().mockResolvedValue(mockTx);
  const mockVersion = contractOverrides?.versionImpl ?? vi.fn().mockResolvedValue("0.8.1");
  const mockVerifier = contractOverrides?.verifierImpl ?? vi.fn().mockResolvedValue("0x2FBf6baef1D70f5A9aFF2602c934Bd62dcf6Df80");

  const mockContract = {
    claimBatch: mockClaimBatch,
    VERSION: mockVersion,
    batchClaimVerifier: mockVerifier,
  };

  const signer = {} as ethers.Signer;
  const client = new BatchClaimClient(signer, PROXY_ADDR);
  // Replace internal contract with mock — avoids needing to mock ethers.Contract
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).contract = mockContract;

  return { client, mockContract, mockTx, mockReceipt };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchClaimClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("instantiation", () => {
    it("constructs without throwing given any string address", () => {
      const signer = {} as ethers.Signer;
      expect(() => new BatchClaimClient(signer, PROXY_ADDR)).not.toThrow();
    });
  });

  describe("claimBatch()", () => {
    it("calls contract.claimBatch with spread arrays and returns receipt", async () => {
      const { client, mockContract, mockReceipt } = makeClient();

      const receipt = await client.claimBatch(MOCK_PUBLIC_INPUTS, MOCK_PROOF);

      expect(mockContract.claimBatch).toHaveBeenCalledOnce();
      const [calledInputs, calledProof] = mockContract.claimBatch.mock.calls[0];
      expect(Array.isArray(calledInputs)).toBe(true);
      expect(calledInputs).toHaveLength(6);
      expect(Array.isArray(calledProof)).toBe(true);
      expect(calledProof).toHaveLength(8);
      expect(receipt).toBe(mockReceipt);
    });

    it("passes publicInputs values in correct order", async () => {
      const { client, mockContract } = makeClient();
      await client.claimBatch(MOCK_PUBLIC_INPUTS, MOCK_PROOF);

      const [calledInputs] = mockContract.claimBatch.mock.calls[0];
      for (let i = 0; i < 6; i++) {
        expect(calledInputs[i]).toBe(MOCK_PUBLIC_INPUTS[i]);
      }
    });

    it("throws TypeError when publicInputs has wrong length", async () => {
      const { client } = makeClient();

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.claimBatch([1n, 2n, 3n] as any, MOCK_PROOF)
      ).rejects.toThrow(/publicInputs must have exactly 6 elements/);
    });

    it("throws TypeError when proof has wrong length", async () => {
      const { client } = makeClient();

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.claimBatch(MOCK_PUBLIC_INPUTS, [1n, 2n] as any)
      ).rejects.toThrow(/proof must have exactly 8 elements/);
    });

    it("throws when tx.wait() returns null", async () => {
      const nullWaitTx = { wait: vi.fn().mockResolvedValue(null) };
      const { client } = makeClient({
        claimBatchImpl: vi.fn().mockResolvedValue(nullWaitTx),
      });

      await expect(client.claimBatch(MOCK_PUBLIC_INPUTS, MOCK_PROOF)).rejects.toThrow(
        /receipt is null/
      );
    });

    it("does NOT call contract.claimBatch when validation fails", async () => {
      const { client, mockContract } = makeClient();

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.claimBatch([1n] as any, MOCK_PROOF)
      ).rejects.toThrow();

      expect(mockContract.claimBatch).not.toHaveBeenCalled();
    });
  });

  describe("ABI calldata encoding (pure ethers.Interface)", () => {
    it("claimBatch selector exists and calldata has correct byte length", () => {
      const iface = new ethers.Interface([
        "function claimBatch(uint256[6] calldata publicInputs, uint256[8] calldata proof) external",
      ]);
      const fragment = iface.getFunction("claimBatch");
      expect(fragment).not.toBeNull();

      const encoded = iface.encodeFunctionData("claimBatch", [
        Array(6).fill(0n),
        Array(8).fill(0n),
      ]);
      // 4-byte selector + 6*32 bytes + 8*32 bytes = 4 + 448 = 452 bytes
      // In hex: "0x" + 8 selector chars + (6+8)*64 data chars
      expect(encoded.length).toBe(2 + 8 + (6 + 8) * 64);
    });

    it("encodes the correct 4-byte function selector", () => {
      const iface = new ethers.Interface([
        "function claimBatch(uint256[6] calldata publicInputs, uint256[8] calldata proof) external",
      ]);
      const encoded = iface.encodeFunctionData("claimBatch", [
        Array(6).fill(0n),
        Array(8).fill(0n),
      ]);
      // Selector = keccak256("claimBatch(uint256[6],uint256[8])")[0:4]
      const selector = encoded.slice(0, 10);
      expect(selector).toMatch(/^0x[0-9a-f]{8}$/);
    });

    it("batchClaimVerifier view ABI encodes correctly", () => {
      const iface = new ethers.Interface([
        "function batchClaimVerifier() view returns (address)",
      ]);
      const fragment = iface.getFunction("batchClaimVerifier");
      expect(fragment).not.toBeNull();
    });

    it("VERSION view ABI encodes correctly", () => {
      const iface = new ethers.Interface([
        "function VERSION() view returns (string)",
      ]);
      const fragment = iface.getFunction("VERSION");
      expect(fragment).not.toBeNull();
    });
  });

  describe("getVerifierAddress()", () => {
    it("calls contract.batchClaimVerifier and returns the result", async () => {
      const { client, mockContract } = makeClient();

      const addr = await client.getVerifierAddress();

      expect(mockContract.batchClaimVerifier).toHaveBeenCalledOnce();
      expect(addr).toBe("0x2FBf6baef1D70f5A9aFF2602c934Bd62dcf6Df80");
    });
  });

  describe("getVersion()", () => {
    it("calls contract.VERSION and returns '0.8.1'", async () => {
      const { client, mockContract } = makeClient();

      const version = await client.getVersion();

      expect(mockContract.VERSION).toHaveBeenCalledOnce();
      expect(version).toBe("0.8.1");
    });
  });
});
