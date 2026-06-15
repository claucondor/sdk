/**
 * resource-check.ts
 *
 * Checks which Janus Cadence resources are present and whether they are
 * up-to-date (i.e., from the current deployer address).
 *
 * Uses account.storage.type(at:) directly for each resource so that
 * MockFT.Vault, JanusFT.CommitmentRegistry, and JanusFlow.MemoKey are each
 * checked independently — no inference across resources.
 */

export type ResourceStatus = "ok" | "outdated" | "missing" | "unknown";

export interface ResourcesStatus {
  mockFTVault: ResourceStatus;
  janusFTRegistry: ResourceStatus;
  memoKey: ResourceStatus;
  shieldedInbox: ResourceStatus;
  shieldedCheckpoint: ResourceStatus;
  anyOutdated: boolean;
}

// ---------------------------------------------------------------------------
// Cadence script — checks resources via storage.type(at:) for each resource
// ---------------------------------------------------------------------------
const RESOURCE_CHECK_SCRIPT = `
import MockFT from 0x4b6bc58bc8bf5dcc
import JanusFT from 0x4b6bc58bc8bf5dcc
import JanusFlow from 0x5dcbeb41055ec57e
import FungibleToken from 0x9a0766d93b6608b7

access(all) fun main(addr: Address): {String: String} {
  let account = getAccount(addr)
  var result: {String: String} = {}

  // === MockFT.Vault ===
  let mockExpected = Type<@MockFT.Vault>()
  let mockStored = account.storage.type(at: /storage/mockFTVault)
  if mockStored == nil { result["mockFTVault"] = "missing" }
  else if mockStored! != mockExpected { result["mockFTVault"] = "outdated" }
  else { result["mockFTVault"] = "ok" }

  // === JanusFT.CommitmentRegistry ===
  let regExpected = Type<@JanusFT.CommitmentRegistry>()
  let regStored = account.storage.type(at: /storage/janusFTRegistry)
  if regStored == nil { result["janusFTRegistry"] = "missing" }
  else if regStored! != regExpected { result["janusFTRegistry"] = "outdated" }
  else { result["janusFTRegistry"] = "ok" }

  // === JanusFlow.MemoKey ===
  let memoExpected = Type<@JanusFlow.MemoKey>()
  let memoStored = account.storage.type(at: /storage/openjanusMemoKey)
  if memoStored == nil { result["memoKey"] = "missing" }
  else if memoStored! != memoExpected { result["memoKey"] = "outdated" }
  else { result["memoKey"] = "ok" }

  result["shieldedInbox"] = "unknown"
  result["shieldedCheckpoint"] = "unknown"

  return result
}
`;

// ---------------------------------------------------------------------------
// checkJanusResourcesStatus
// ---------------------------------------------------------------------------

/**
 * Queries the Flow network and returns the status of each Janus Cadence
 * resource for the given address.
 *
 * Each resource is checked independently via storage.type(at:) — no inference
 * across resources. JanusFT.CommitmentRegistry, MockFT.Vault, and
 * JanusFlow.MemoKey are all directly inspected.
 */
export async function checkJanusResourcesStatus(
  cadenceAddress: string,
): Promise<ResourcesStatus> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fcl = await import("@onflow/fcl") as any;
  const raw = (await fcl.query({
    cadence: RESOURCE_CHECK_SCRIPT,
    args: (arg: (v: unknown, t: unknown) => unknown, t: { Address: unknown }) => [
      arg(cadenceAddress, t.Address),
    ],
  })) as Record<string, string>;

  const mockFTVault = (raw["mockFTVault"] ?? "unknown") as ResourceStatus;
  const janusFTRegistry = (raw["janusFTRegistry"] ?? "unknown") as ResourceStatus;
  const memoKey = (raw["memoKey"] ?? "unknown") as ResourceStatus;
  const shieldedInbox = (raw["shieldedInbox"] ?? "unknown") as ResourceStatus;
  const shieldedCheckpoint = (raw["shieldedCheckpoint"] ?? "unknown") as ResourceStatus;

  const anyOutdated =
    mockFTVault === "outdated" ||
    janusFTRegistry === "outdated" ||
    memoKey === "outdated" ||
    shieldedInbox === "outdated" ||
    shieldedCheckpoint === "outdated";

  return {
    mockFTVault,
    janusFTRegistry,
    memoKey,
    shieldedInbox,
    shieldedCheckpoint,
    anyOutdated,
  };
}
