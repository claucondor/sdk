/**
 * cadence/mockft-vault.ts — MockFT vault version detection.
 *
 * Detects whether a Flow account's MockFT vault capability is correctly typed
 * as the concrete MockFT.Vault (v0.8 "ok"), typed as generic FungibleToken.Receiver
 * ("outdated"), or missing entirely ("missing").
 *
 * Used by the /faucet page to prompt users with outdated vaults to reinstall.
 */

const SCRIPT = `
import MockFT from 0x4b6bc58bc8bf5dcc
import FungibleToken from 0x9a0766d93b6608b7

access(all) fun main(addr: Address): String {
  let account = getAccount(addr)
  let recvCap = account.capabilities.get<&{FungibleToken.Receiver}>(/public/mockFTReceiver)
  let vaultCap = account.capabilities.get<&MockFT.Vault>(/public/mockFTReceiver)

  if !recvCap.check() && !vaultCap.check() { return "missing" }
  if recvCap.check() && !vaultCap.check() { return "outdated" }
  if vaultCap.check() { return "ok" }
  return "unknown"
}
`;

/**
 * Queries the chain to determine the version status of a MockFT vault.
 *
 * @param cadenceAddress  The Flow account address to check (e.g. "0xe3e678e0c1e6ad79")
 * @returns "ok"       — concrete MockFT.Vault capability published (v0.8-ready)
 *          "outdated" — only generic FungibleToken.Receiver capability exists (pre-v0.8)
 *          "missing"  — no MockFT capabilities published at all
 *          "unknown"  — unexpected capability combination
 */
export async function checkMockFTVaultVersion(
  cadenceAddress: string,
): Promise<"ok" | "outdated" | "missing" | "unknown"> {
  // FCL is client-only — lazy import so server-side pages don't break.
  const fcl = await import("@onflow/fcl");
  const result = (await fcl.query({
    cadence: SCRIPT,
    args: (arg: unknown, typeOf: unknown) => [
      // @ts-expect-error FCL types are dynamic
      arg(cadenceAddress, typeOf.Address),
    ],
  })) as string;
  return result as "ok" | "outdated" | "missing" | "unknown";
}
