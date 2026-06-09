/**
 * crypto/snapshot-schema.ts — Re-exports from checkpoint-schema.ts (v0.8 canonical).
 * @deprecated Import directly from checkpoint-schema.ts instead.
 */
export { encryptSnapshot, decryptSnapshot } from "./checkpoint-schema";
export type { MemoCiphertext } from "./checkpoint-schema";
export { SNAPSHOT_TIMESTAMP_UNIT } from "../types";
