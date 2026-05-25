import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "primitives/index": "src/primitives/index.ts",
    "tokens/index": "src/tokens/index.ts",
    "network/index": "src/network/index.ts",
    "crypto/index": "src/crypto/index.ts",
    "utils/index": "src/utils/index.ts",
    "tokens-v2/index": "src/tokens-v2/index.ts",
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
