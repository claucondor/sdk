/**
 * network/coa.ts — Cadence Owned Account (COA) helpers
 *
 * A COA is the EVM address controlled by a Cadence account on Flow.
 * Cross-VM transactions (Cadence → EVM) use the COA as the msg.sender.
 *
 * Known COA mappings (Flow EVM testnet):
 *   Alice (lab)            0x7599043aea001283  → 0x000000000000000000000002b7557ee5d4a32d06
 *   Bob                    0xd807a3992d7be612  → 0x00000000000000000000000250d93efba617e0bf
 *   Charlie                0x3c601a443c81e6cd  → 0x00000000000000000000000249065458581f9bf0
 *   Dave                   0xd32d9100e1fe983b  → 0x0000000000000000000000027b94cfc8a64971cd
 *   openjanus-flow         0xbef3c77681c15397  → 0x0000000000000000000000022f6b30af48a94787
 *                                                  (v0.3 EVM proxy admin/owner)
 *
 * The v0.3 JanusFlow Cadence router lives at 0x5dcbeb41055ec57e and does NOT
 * need a COA (it borrows the signer's COA for each cross-VM call). The previous
 * router (0xbef3c77681c15397) and the legacy Pedersen zombie (0x28fef3d1d6a12800)
 * are intentionally NOT included as canonical entries — they are deprecated.
 */

import type { FlowNetwork } from "./flow-client";
import { NETWORK_CONFIG } from "./flow-client";

/** Map of known Cadence address → COA EVM address (testnet only) */
export const KNOWN_COAS: Record<string, string> = {
  "0x7599043aea001283": "0x000000000000000000000002b7557ee5d4a32d06", // Alice (lab)
  "0xd807a3992d7be612": "0x00000000000000000000000250d93efba617e0bf", // Bob
  "0x3c601a443c81e6cd": "0x00000000000000000000000249065458581f9bf0", // Charlie
  "0xd32d9100e1fe983b": "0x0000000000000000000000027b94cfc8a64971cd", // Dave
  "0x374a28ddf00498e4": "0x0000000000000000000000027eb18dc34b9966fd", // Eve (placeholder)
  "0xbef3c77681c15397": "0x0000000000000000000000022f6b30af48a94787", // openjanus-flow (v0.7 admin)
  "0x4b6bc58bc8bf5dcc": "0x0000000000000000000000020885d7ad3582356a", // v0.8 deployer (owner of all v0.8 proxies)
};

/**
 * Cadence script to get the COA EVM address for a given Cadence account.
 * Returns empty string if the account has no COA.
 */
export const SCRIPT_GET_COA_ADDRESS = `
import EVM from 0x8c5303eaa26202d6

access(all) fun main(address: Address): String {
    if let coa = getAuthAccount<auth(Storage) &Account>(address)
            .storage
            .borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm) {
        return coa.address().toString()
    }
    return ""
}
`;

/**
 * Get the known COA EVM address for a Cadence address.
 * Returns null if not in the known-COA map.
 *
 * For unknown addresses, use getCOAAddressOnChain() to query testnet.
 */
export function getKnownCOA(cadenceAddress: string): string | null {
  const normalized = cadenceAddress.toLowerCase();
  for (const [k, v] of Object.entries(KNOWN_COAS)) {
    if (k.toLowerCase() === normalized) return v;
  }
  return null;
}

/**
 * Query the COA EVM address for any Cadence account via FCL script.
 *
 * @param cadenceAddress  Cadence account address (e.g. "0xd807a3992d7be612")
 * @param network         Target network
 * @returns               EVM address string, or null if no COA
 */
export async function getCOAAddressOnChain(
  cadenceAddress: string,
  network: FlowNetwork = "testnet"
): Promise<string | null> {
  const fcl = await import("@onflow/fcl");
  const t = await import("@onflow/types");
  const config = NETWORK_CONFIG[network];

  fcl.config({ "accessNode.api": config.flowAccessApi });

  const result = await fcl.query({
    cadence: SCRIPT_GET_COA_ADDRESS,
    args: (arg: unknown, typeOf: unknown) => [
      // @ts-expect-error FCL types are dynamic
      arg(cadenceAddress, typeOf.Address),
    ],
  });

  if (!result || result === "") return null;
  return result as string;
}

// ---------------------------------------------------------------------------
// COA helpers — public scripts via /public/evm capability
// ---------------------------------------------------------------------------

/** Cadence script — query COA EVM hex via the published /public/evm capability. */
const SCRIPT_GET_COA_EVM_FROM_PUBLIC = `
import EVM from 0x8c5303eaa26202d6

access(all) fun main(addr: Address): String {
    let acct = getAccount(addr)
    let coa = acct.capabilities.borrow<&EVM.CadenceOwnedAccount>(/public/evm)
      ?? panic("No COA at /public/evm for ".concat(addr.toString()))
    return coa.address().toString()
}
`;

/** Cadence script — check whether an account publishes a /public/evm COA cap. */
const SCRIPT_HAS_COA = `
import EVM from 0x8c5303eaa26202d6

access(all) fun main(addr: Address): Bool {
    let acct = getAccount(addr)
    let coa = acct.capabilities.borrow<&EVM.CadenceOwnedAccount>(/public/evm)
    return coa != nil
}
`;

/** Cadence script — read attoFLOW balance of an account's COA. */
const SCRIPT_GET_COA_BALANCE_WEI = `
import EVM from 0x8c5303eaa26202d6

access(all) fun main(addr: Address): UInt {
    let acct = getAccount(addr)
    let coa = acct.capabilities.borrow<&EVM.CadenceOwnedAccount>(/public/evm)
      ?? panic("No COA")
    return coa.balance().attoflow
}
`;

/** Cadence script — read FlowToken.Vault balance (UFix64) for an account. */
const SCRIPT_GET_VAULT_BALANCE_UFIX64 = `
import FungibleToken from 0x9a0766d93b6608b7
import FlowToken from 0x7e60df042a9c0868

access(all) fun main(addr: Address): UFix64 {
    let acct = getAccount(addr)
    let vault = acct.capabilities.borrow<&{FungibleToken.Balance}>(/public/flowTokenBalance)
      ?? panic("No FlowToken.Balance capability")
    return vault.balance
}
`;

/**
 * Resolve a Flow account's COA EVM address using its published
 * /public/evm capability. Throws if no COA is published.
 *
 * Prefer this over getCOAAddressOnChain when you want a normalized 0x-prefixed
 * hex and a thrown error for missing COAs (instead of nil).
 */
export async function getCoaEvmAddress(
  cadenceAddress: string,
  _network: FlowNetwork = "testnet"
): Promise<string> {
  const fcl = await import("@onflow/fcl");
  const result = (await fcl.query({
    cadence: SCRIPT_GET_COA_EVM_FROM_PUBLIC,
    args: (arg: unknown, typeOf: unknown) => [
      // @ts-expect-error FCL types are dynamic
      arg(cadenceAddress, typeOf.Address),
    ],
  })) as string;
  return result.startsWith("0x") ? result : `0x${result}`;
}

/**
 * Check whether a Flow account publishes a COA at /public/evm. Returns false
 * on any failure (no COA, network error, missing capability).
 */
export async function hasCOA(
  cadenceAddress: string,
  _network: FlowNetwork = "testnet"
): Promise<boolean> {
  const fcl = await import("@onflow/fcl");
  try {
    const result = (await fcl.query({
      cadence: SCRIPT_HAS_COA,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(cadenceAddress, typeOf.Address),
      ],
    })) as boolean;
    return result === true;
  } catch {
    return false;
  }
}

/**
 * Read a Flow account's COA EVM balance in wei (attoFLOW).
 * Returns 0n on any error.
 */
export async function getCoaBalanceWei(
  cadenceAddress: string,
  _network: FlowNetwork = "testnet"
): Promise<bigint> {
  const fcl = await import("@onflow/fcl");
  try {
    const result = (await fcl.query({
      cadence: SCRIPT_GET_COA_BALANCE_WEI,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(cadenceAddress, typeOf.Address),
      ],
    })) as string;
    return BigInt(result);
  } catch {
    return 0n;
  }
}

/**
 * Read a Flow account's FlowToken.Vault balance in wei (UFix64 -> wei
 * via *1e18). Returns 0n on any error.
 */
export async function getFlowVaultBalanceWei(
  cadenceAddress: string,
  _network: FlowNetwork = "testnet"
): Promise<bigint> {
  const fcl = await import("@onflow/fcl");
  try {
    const result = (await fcl.query({
      cadence: SCRIPT_GET_VAULT_BALANCE_UFIX64,
      args: (arg: unknown, typeOf: unknown) => [
        // @ts-expect-error FCL types are dynamic
        arg(cadenceAddress, typeOf.Address),
      ],
    })) as string;
    return parseFlowToWei(result);
  } catch {
    return 0n;
  }
}

/**
 * Parse a UFix64-style FLOW string ("12.34000000") to wei (*1e18).
 * Truncates anything beyond 18 fractional digits.
 */
function parseFlowToWei(flowStr: string): bigint {
  const trimmed = flowStr.trim();
  const parts = trimmed.split(".");
  const wholeStr = parts[0] || "0";
  let fracStr = parts[1] || "";
  while (fracStr.length < 18) fracStr += "0";
  if (fracStr.length > 18) fracStr = fracStr.slice(0, 18);
  const combined = wholeStr + fracStr;
  const clean = combined.replace(/^0+/, "") || "0";
  return BigInt(clean);
}

// ---------------------------------------------------------------------------
// COA setup — idempotent transaction template
// ---------------------------------------------------------------------------

/**
 * Cadence transaction template: idempotent COA setup. Creates an
 * EVM.CadenceOwnedAccount at /storage/evm AND publishes a public capability
 * at /public/evm if one is not already present.
 *
 * Safe to run multiple times — early-returns if the COA already exists.
 *
 * Required entitlements on the signer: SaveValue, IssueStorageCapabilityController,
 * PublishCapability.
 */
export const TX_SETUP_COA = `
import EVM from 0x8c5303eaa26202d6

transaction {
    prepare(signer: auth(SaveValue, IssueStorageCapabilityController, PublishCapability) &Account) {
        if signer.storage.borrow<&EVM.CadenceOwnedAccount>(from: /storage/evm) != nil {
            log("COA already exists at /storage/evm — skipping setup")
            return
        }
        let coa <- EVM.createCadenceOwnedAccount()
        log("Created COA with EVM address: ".concat(coa.address().toString()))
        signer.storage.save(<-coa, to: /storage/evm)
        let cap = signer.capabilities.storage.issue<&EVM.CadenceOwnedAccount>(/storage/evm)
        signer.capabilities.publish(cap, at: /public/evm)
        log("COA setup complete — ready for cross-VM shielded operations")
    }
}
`;
