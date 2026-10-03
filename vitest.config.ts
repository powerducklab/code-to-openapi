import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // TypeScript analysis of real-world multi-file fixtures can exceed the
    // 5s default under concurrent load; give each test a generous budget.
    testTimeout: 20000,
    hookTimeout: 30000,
    pool: "threads",
  },
});
