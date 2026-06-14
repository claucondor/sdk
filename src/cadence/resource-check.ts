/**
 * resource-check.ts
 *
 * Checks which Janus Cadence resources are present and whether they are
 * up-to-date (i.e., from the current deployer address).
 *
 * For resources that have a public capability we can determine whether the cap
 * resolves to the currently-deployed contract type.  For JanusFT.CommitmentRegistry
 * there is NO public capability, so we infer its status from MockFT.Vault
 * (both live under the same deployer and are reinstalled together).
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
// Cadence script — checks resources that have a public capability
// ---------------------------------------------------------------------------
const RESOURCE_CHECK_SCRIPT = `
import MockFT from 0x4b6bc58bc8bf5dcc
import JanusFlow from 0x5dcbeb41055ec57e
import ShieldedInbox from 0x4b6bc58bc8bf5dcc
import ShieldedCheckpoint from 0xd1a02aa46d9151bb
import FungibleToken from 0x9a0766d93b6608b7

access(all) fun main(addr: Address): {String: String} {
  let account = getAccount(addr)
  var result: {String: String} = {}

  // MockFT vault — check if concrete-typed cap exists vs generic receiver only
  let mockVaultCap = account.capabilities.get<&MockFT.Vault>(/public/mockFTReceiver)
  let mockRecvCap  = account.capabilities.get<&{FungibleToken.Receiver}>(/public/mockFTReceiver)
  if !mockRecvCap.check() && !mockVaultCap.check() {
    result["mockFTVault"] = "missing"
  } else if mockRecvCap.check() && !mockVaultCap.check() {
    result["mockFTVault"] = "outdated"
  } else if mockVaultCap.check() {
    result["mockFTVault"] = "ok"
  } else {
    result["mockFTVault"] = "unknown"
  }

  // MemoKey — public cap exists?
  let memoKeyCap = account.capabilities.get<&{JanusFlow.MemoKeyPublic}>(/public/openjanusMemoKey)
  if !memoKeyCap.check() {
    result["memoKey"] = "missing"
  } else {
    result["memoKey"] = "ok"
  }

  // ShieldedInbox — public cap exists?
  let inboxCap = account.capabilities.get<&{ShieldedInbox.Receiver}>(/public/shieldedInbox)
  if !inboxCap.check() {
    result["shieldedInbox"] = "missing"
  } else {
    result["shieldedInbox"] = "ok"
  }

  // ShieldedCheckpoint — public cap exists?
  let cpCap = account.capabilities.get<&{ShieldedCheckpoint.Metadata}>(/public/shieldedCheckpoint)
  if !cpCap.check() {
    result["shieldedCheckpoint"] = "missing"
  } else {
    result["shieldedCheckpoint"] = "ok"
  }

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
 * Note: JanusFT.CommitmentRegistry has no public capability so its status is
 * inferred: if MockFT.Vault is "outdated" (same deployer change) the registry
 * is also treated as "outdated"; otherwise it is "unknown".
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
  const memoKey = (raw["memoKey"] ?? "unknown") as ResourceStatus;
  const shieldedInbox = (raw["shieldedInbox"] ?? "unknown") as ResourceStatus;
  const shieldedCheckpoint = (raw["shieldedCheckpoint"] ?? "unknown") as ResourceStatus;

  // janusFTRegistry: inferred from mockFTVault (same deployer, same deployer change)
  const janusFTRegistry: ResourceStatus =
    mockFTVault === "outdated" ? "outdated" : "unknown";

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
