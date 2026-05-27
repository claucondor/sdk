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
  "0xbef3c77681c15397": "0x0000000000000000000000022f6b30af48a94787", // openjanus-flow (UUPS proxy owner)
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
