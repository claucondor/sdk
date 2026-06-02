/**
 * Unit tests for cadence-scanner JSON-CDC decoding.
 * Tests the offline payload parsing — actual REST queries are integration-tested.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scanCadenceSnapshots, scanCadenceIncomingNotes } from "../../src/scan/cadence-scanner";

/** Build a fake JSON-CDC composite event payload (base64-encoded) */
function buildEventPayload(eventId: string, fields: Array<{ name: string; value: { type: string; value: unknown } }>): string {
  const payload = {
    type: "Event",
    value: {
      id: eventId,
      fields,
    },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function buildBytes(bytes: number[]): { type: string; value: Array<{ type: string; value: string }> } {
  return {
    type: "Array",
    value: bytes.map((b) => ({ type: "UInt8", value: b.toString() })),
  };
}

const ALICE = "0x7599043aea001283";
const BOB = "0xd807a3992d7be612";
const CONTRACT_ADDR = "0x7599043aea001283";
const CONTRACT_NAME = "JanusMockFT";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("cadence-scanner — JSON-CDC event parsing", () => {
  it("scanCadenceSnapshots picks up WrapWithSnapshot for the user as actor", async () => {
    const wrapPayload = buildEventPayload(
      `A.7599043aea001283.JanusMockFT.WrapWithSnapshot`,
      [
        { name: "account", value: { type: "Address", value: ALICE } },
        { name: "grossAmount", value: { type: "UFix64", value: "50.0" } },
        { name: "netAmount", value: { type: "UFix64", value: "49.95" } },
        { name: "encryptedSnapshot", value: buildBytes([1, 2, 3, 4]) },
        { name: "ephPubX", value: { type: "UInt256", value: "111" } },
        { name: "ephPubY", value: { type: "UInt256", value: "222" } },
      ]
    );

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("blocks?height=sealed")) {
        return new Response(JSON.stringify([{ header: { height: "300000" } }]), { status: 200 });
      }
      if (u.includes("type=A.7599043aea001283.JanusMockFT.WrapWithSnapshot")) {
        return new Response(
          JSON.stringify([{
            block_height: "299900",
            block_timestamp: "2026-06-01T12:00:00.000Z",
            block_id: "abc",
            events: [{
              type: "A.7599043aea001283.JanusMockFT.WrapWithSnapshot",
              transaction_id: "tx-wrap-1",
              transaction_index: "0",
              event_index: "0",
              payload: wrapPayload,
            }],
          }]),
          { status: 200 }
        );
      }
      // Other event types return empty
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const events = await scanCadenceSnapshots(ALICE, CONTRACT_ADDR, CONTRACT_NAME, {
      fromBlock: 299_900,
      toBlock: 300_000,
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("wrap");
    expect(events[0]!.txHash).toBe("tx-wrap-1");
    expect(events[0]!.ephPubkey.x).toBe(111n);
    expect(events[0]!.ephPubkey.y).toBe(222n);
    expect(Array.from(events[0]!.ciphertext)).toEqual([1, 2, 3, 4]);
    expect(events[0]!.timestampMs).toBe(new Date("2026-06-01T12:00:00.000Z").getTime());
  });

  it("scanCadenceSnapshots filters out events for OTHER users", async () => {
    const wrapPayloadForBob = buildEventPayload(
      `A.7599043aea001283.JanusMockFT.WrapWithSnapshot`,
      [
        { name: "account", value: { type: "Address", value: BOB } },
        { name: "grossAmount", value: { type: "UFix64", value: "10.0" } },
        { name: "netAmount", value: { type: "UFix64", value: "9.99" } },
        { name: "encryptedSnapshot", value: buildBytes([9, 9, 9]) },
        { name: "ephPubX", value: { type: "UInt256", value: "1" } },
        { name: "ephPubY", value: { type: "UInt256", value: "2" } },
      ]
    );

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("blocks?height=sealed")) {
        return new Response(JSON.stringify([{ header: { height: "300000" } }]), { status: 200 });
      }
      if (u.includes("type=A.7599043aea001283.JanusMockFT.WrapWithSnapshot")) {
        return new Response(
          JSON.stringify([{
            block_height: "299900",
            block_timestamp: "2026-06-01T12:00:00.000Z",
            block_id: "abc",
            events: [{
              type: "A.7599043aea001283.JanusMockFT.WrapWithSnapshot",
              transaction_id: "tx-bob-wrap",
              transaction_index: "0",
              event_index: "0",
              payload: wrapPayloadForBob,
            }],
          }]),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    // Alice scans — Bob's wrap should be filtered out
    const events = await scanCadenceSnapshots(ALICE, CONTRACT_ADDR, CONTRACT_NAME, {
      fromBlock: 299_900,
      toBlock: 300_000,
    });
    expect(events).toHaveLength(0);
  });

  it("scanCadenceIncomingNotes picks up ShieldedTransferWithSnapshot where user is recipient", async () => {
    const transferPayload = buildEventPayload(
      `A.7599043aea001283.JanusMockFT.ShieldedTransferWithSnapshot`,
      [
        { name: "sender", value: { type: "Address", value: ALICE } },
        { name: "recipient", value: { type: "Address", value: BOB } },
        { name: "encryptedSnapshot", value: buildBytes([7, 7, 7]) },
        { name: "ephPubX", value: { type: "UInt256", value: "100" } },
        { name: "ephPubY", value: { type: "UInt256", value: "200" } },
        { name: "encryptedNoteTo", value: buildBytes([42, 43, 44]) },
        { name: "ephPubToX", value: { type: "UInt256", value: "777" } },
        { name: "ephPubToY", value: { type: "UInt256", value: "888" } },
      ]
    );

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("blocks?height=sealed")) {
        return new Response(JSON.stringify([{ header: { height: "300000" } }]), { status: 200 });
      }
      if (u.includes("type=A.7599043aea001283.JanusMockFT.ShieldedTransferWithSnapshot")) {
        return new Response(
          JSON.stringify([{
            block_height: "299950",
            block_timestamp: "2026-06-01T13:00:00.000Z",
            block_id: "def",
            events: [{
              type: "A.7599043aea001283.JanusMockFT.ShieldedTransferWithSnapshot",
              transaction_id: "tx-xfer",
              transaction_index: "0",
              event_index: "0",
              payload: transferPayload,
            }],
          }]),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    // Bob scans for incoming notes
    const notes = await scanCadenceIncomingNotes(BOB, CONTRACT_ADDR, CONTRACT_NAME, {
      fromBlock: 299_950,
      toBlock: 300_000,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.txHash).toBe("tx-xfer");
    expect(Array.from(notes[0]!.ciphertext)).toEqual([42, 43, 44]);
    expect(notes[0]!.ephPubkey.x).toBe(777n);
    expect(notes[0]!.ephPubkey.y).toBe(888n);
  });

  it("scanCadenceIncomingNotes filters out notes where recipient is someone else", async () => {
    const charlie = "0x3c601a443c81e6cd";
    const transferToCharlie = buildEventPayload(
      `A.7599043aea001283.JanusMockFT.ShieldedTransferWithSnapshot`,
      [
        { name: "sender", value: { type: "Address", value: ALICE } },
        { name: "recipient", value: { type: "Address", value: charlie } },
        { name: "encryptedSnapshot", value: buildBytes([1]) },
        { name: "ephPubX", value: { type: "UInt256", value: "1" } },
        { name: "ephPubY", value: { type: "UInt256", value: "2" } },
        { name: "encryptedNoteTo", value: buildBytes([1, 2]) },
        { name: "ephPubToX", value: { type: "UInt256", value: "3" } },
        { name: "ephPubToY", value: { type: "UInt256", value: "4" } },
      ]
    );

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("blocks?height=sealed")) {
        return new Response(JSON.stringify([{ header: { height: "300000" } }]), { status: 200 });
      }
      if (u.includes("ShieldedTransferWithSnapshot")) {
        return new Response(
          JSON.stringify([{
            block_height: "299960",
            block_timestamp: "2026-06-01T13:30:00.000Z",
            block_id: "ghi",
            events: [{
              type: "A.7599043aea001283.JanusMockFT.ShieldedTransferWithSnapshot",
              transaction_id: "tx-to-charlie",
              transaction_index: "0",
              event_index: "0",
              payload: transferToCharlie,
            }],
          }]),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const notes = await scanCadenceIncomingNotes(BOB, CONTRACT_ADDR, CONTRACT_NAME, {
      fromBlock: 299_960,
      toBlock: 300_000,
    });
    expect(notes).toHaveLength(0);
  });

  it("returns events sorted by blockHeight ascending", async () => {
    const ev1 = buildEventPayload(`A.7599043aea001283.JanusMockFT.WrapWithSnapshot`, [
      { name: "account", value: { type: "Address", value: ALICE } },
      { name: "grossAmount", value: { type: "UFix64", value: "1.0" } },
      { name: "netAmount", value: { type: "UFix64", value: "0.99" } },
      { name: "encryptedSnapshot", value: buildBytes([1]) },
      { name: "ephPubX", value: { type: "UInt256", value: "1" } },
      { name: "ephPubY", value: { type: "UInt256", value: "1" } },
    ]);
    const ev2 = buildEventPayload(`A.7599043aea001283.JanusMockFT.WrapWithSnapshot`, [
      { name: "account", value: { type: "Address", value: ALICE } },
      { name: "grossAmount", value: { type: "UFix64", value: "2.0" } },
      { name: "netAmount", value: { type: "UFix64", value: "1.99" } },
      { name: "encryptedSnapshot", value: buildBytes([2]) },
      { name: "ephPubX", value: { type: "UInt256", value: "2" } },
      { name: "ephPubY", value: { type: "UInt256", value: "2" } },
    ]);

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("blocks?height=sealed")) {
        return new Response(JSON.stringify([{ header: { height: "300000" } }]), { status: 200 });
      }
      if (u.includes("WrapWithSnapshot")) {
        return new Response(
          JSON.stringify([
            {
              block_height: "299990",
              block_timestamp: "2026-06-01T14:00:00.000Z",
              block_id: "later",
              events: [{
                type: "A.7599043aea001283.JanusMockFT.WrapWithSnapshot",
                transaction_id: "tx-later",
                transaction_index: "0",
                event_index: "0",
                payload: ev2,
              }],
            },
            {
              block_height: "299900",
              block_timestamp: "2026-06-01T12:00:00.000Z",
              block_id: "earlier",
              events: [{
                type: "A.7599043aea001283.JanusMockFT.WrapWithSnapshot",
                transaction_id: "tx-earlier",
                transaction_index: "0",
                event_index: "0",
                payload: ev1,
              }],
            },
          ]),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const events = await scanCadenceSnapshots(ALICE, CONTRACT_ADDR, CONTRACT_NAME, {
      fromBlock: 299_900,
      toBlock: 300_000,
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.txHash).toBe("tx-earlier");
    expect(events[1]!.txHash).toBe("tx-later");
    expect(events[0]!.blockHeight).toBeLessThan(events[1]!.blockHeight);
  });
});
