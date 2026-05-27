/**
 * tokens/types.ts — Types for the v0.3 Pedersen-based JanusToken / JanusFlow
 *
 * v0.3 uses Pedersen commitments on BabyJubJub for per-account balances:
 *   commitments[user] = Pedersen(value, blinding)
 * Updates are homomorphic (point-wise add/sub) so shielded transfers move a
 * sender's commit to a recipient's commit without revealing the amount.
 *
 * The v0.2 ElGamal `Ciphertext { c1, c2 }` shape has been removed at the type
 * level — v0.2 leaked the amount on every wrap and (cleartext) on every
 * shielded transfer. v0.3 deployments use only `Point` for balance commits.
 */

import type { Point } from "../types/commitment";
import type { FlowNetwork } from "../network/flow-client";

export type { Point, FlowNetwork };

// ---------------------------------------------------------------------------
// Deployment configuration
// ---------------------------------------------------------------------------

/** Constructor options for JanusToken / JanusFlow (v0.3). */
export interface TokenOptions {
  /** Deployed EVM address of the JanusToken (proxy) */
  evmAddress: string;
  /** Network to connect to */
  network: FlowNetwork;
  /** Address of the BabyJub.sol helper contract */
  babyJubAddress?: string;
  /** v0.3 AmountDiscloseVerifier address */
  amountDiscloseVerifierAddress?: string;
  /** v0.3 ConfidentialTransferVerifier address */
  confidentialTransferVerifierAddress?: string;
}

/** A fully described v0.3 token deployment. */
export interface TokenDeployment {
  /** JanusFlow EVM proxy address */
  evm: string;
  /** Cadence router address */
  cadence: string;
  /** Cadence contract name */
  cadenceContractName: string;
  /** ZK verifier addresses */
  verifiers: {
    AmountDisclose: string;
    ConfidentialTransfer: string;
  };
  /** BabyJub helper address */
  babyJub: string;
  /** Admin / proxy owner address (EVM) */
  owner: string;
}
