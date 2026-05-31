/**
 * primitives/index.ts — Public primitives surface
 *
 * Low-level cryptographic building blocks. Advanced users and extension
 * authors import from here. Application developers prefer the higher-level
 * crypto/ and tokens/ modules.
 */

// BabyJubJub curve
export {
  CURVE_A,
  CURVE_D,
  GENERATOR_G,
  BASE8,
  BABYJUB_CONTRACT_ADDRESS,
  FLOW_EVM_TESTNET_RPC,
  BABY_ADD_SELECTOR,
  isOnCurveLocal,
  negatePoint,
  isIdentity,
  encodeBabyAdd,
  decodeBabyAddResult,
  babyAddOnChain,
  isOnCurveOnChain,
  negateOnChain,
  identityOnChain,
} from "./babyjub";
export type { BabyJubContractOptions } from "./babyjub";

// Pedersen commitments
export {
  PEDERSEN_CADENCE_ADDRESS,
  BABYJUB_EVM_ADDRESS,
  FLOW_TESTNET_ACCESS_NODE,
  computeCommitment,
  computeCommitmentV05,
  addCommitmentsLocal,
  subCommitmentsLocal,
  negateCommitment,
  identityCommitment,
  isIdentityCommitment,
  commitmentToFclArgs,
  SCRIPT_IDENTITY,
  SCRIPT_NEGATE,
  SCRIPT_IS_IDENTITY,
} from "./pedersen";

// Groth16
export {
  VERIFIER_ADDRESS,
  VERIFY_PROOF_SELECTOR,
  proofToEVMFormat,
  pubSignalsToArray,
  parsePublicSignals,
  verifyOnChain,
  estimateVerifyGas,
  verifyLocally,
  prove,
  proveForEVM,
} from "./groth16";
export type { VerifyOnChainOptions, ProveOptions } from "./groth16";
