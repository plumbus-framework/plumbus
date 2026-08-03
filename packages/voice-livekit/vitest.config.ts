import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Isolate each file in a fork so `vi.mock('livekit-client')` cannot race with
    // other files that also dynamic-import the real SDK under turbo parallelism.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
