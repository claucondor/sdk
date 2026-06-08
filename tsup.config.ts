import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "primitives/index": "src/primitives/index.ts",
    "network/index": "src/network/index.ts",
    "crypto/index": "src/crypto/index.ts",
    "utils/index": "src/utils/index.ts",
    // v0.6 new modules
    "adapters/index": "src/adapters/index.ts",
    "orchestration/index": "src/orchestration/index.ts",
    "scan/index": "src/scan/index.ts",
    // v0.7.5 cadence-tx builders (PrivateTip EVM-recipient helpers)
    "cadence-tx/index": "src/cadence-tx/index.ts",
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
