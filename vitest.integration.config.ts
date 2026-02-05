import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.test.ts"],
    testTimeout: 60000, // Integration tests may take longer
    hookTimeout: 60000,
    // Run tests sequentially to avoid beads CLI conflicts
    pool: "forks",
    singleFork: true,
    fileParallelism: false, // Run test files one at a time
  },
});
