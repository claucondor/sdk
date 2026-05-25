import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 120000,
    hookTimeout: 30000,
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    reporter: "verbose",
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      "@openjanus/sdk": "/home/oydual3/openjanus-sdk/src",
    },
  },
});
