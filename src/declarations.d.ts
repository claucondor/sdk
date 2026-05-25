/**
 * Module declarations for packages that don't ship TypeScript definitions.
 */

declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmPath: string,
      zkeyPath: string
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(
      vk: object,
      publicSignals: string[],
      proof: unknown
    ): Promise<boolean>;
  };
}

declare module "circomlibjs" {
  export function buildBabyjub(): Promise<{
    F: {
      e(n: bigint | string | number): unknown;
      toObject(n: unknown): bigint;
    };
    addPoint(p1: unknown[], p2: unknown[]): unknown[];
    mulPointEscalar(p: unknown[], scalar: bigint): unknown[];
    unpackPoint(buf: unknown): unknown[];
  }>;

  export function buildPedersenHash(): Promise<{
    hash(buf: Buffer | Uint8Array): unknown;
  }>;
}

declare module "@onflow/fcl" {
  export function config(opts: Record<string, unknown>): void;
  export function query(opts: {
    cadence: string;
    args?: (arg: unknown, typeOf: unknown) => unknown[];
  }): Promise<unknown>;
  export function mutate(opts: {
    cadence: string;
    args?: (arg: unknown, typeOf: unknown) => unknown[];
    proposer?: unknown;
    payer?: unknown;
    authorizations?: unknown[];
    limit?: number;
  }): Promise<string>;
  export function tx(txId: string): {
    onceSealed(): Promise<unknown>;
  };
  export function authenticate(): Promise<void>;
  export function unauthenticate(): void;
  export const authz: unknown;
}

declare module "@onflow/types" {
  export const Address: unknown;
  export const UInt256: unknown;
  export const UFix64: unknown;
  export const String: unknown;
  export const Bool: unknown;
  export const UInt64: unknown;
  export const Array: (type: unknown) => unknown;
}
