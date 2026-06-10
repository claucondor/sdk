import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "primitives/index": "src/primitives/index.ts",
    "network/index": "src/network/index.ts",
    "crypto/index": "src/crypto/index.ts",
    "utils/index": "src/utils/index.ts",
    // v0.8 modules
    "adapters/index": "src/adapters/index.ts",
    "orchestration/index": "src/orchestration/index.ts",
    "inbox/index": "src/inbox/index.ts",
    "checkpoint/index": "src/checkpoint/index.ts",
    "cadence/index": "src/cadence/index.ts",
    // v0.8.1 modules
    "batchClaim/index": "src/batchClaim/index.ts",
    "proof/batch-claim": "src/proof/batch-claim.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  outDir: "dist",
  target: "node18",
  external: [
    // Keep heavy WASM deps as external — they're installed by consuming apps
    "snarkjs",
    "circomlibjs",
    "ethers",
    "@onflow/fcl",
    "@onflow/types",
  ],
});
