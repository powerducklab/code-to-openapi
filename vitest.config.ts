import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Corpus checkouts are scan inputs, not this package's executable tests.
    include: ["test/**/*.test.ts"],
    // TypeScript analysis of real-world multi-file fixtures can exceed the
    // 5s default under concurrent load; give each test a generous budget.
    testTimeout: 20000,
    hookTimeout: 30000,
    // Each suite loads WASM grammars. Isolate their V8 lifetimes in processes:
    // Node 23 worker teardown can race WASM background compilation/GC.
    pool: "forks",
    maxWorkers: 4,
  },
});
