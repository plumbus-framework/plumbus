import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    pool: "threads",
    maxWorkers: process.env.VITEST_MAX_WORKERS ? undefined : 2,
  },
});
