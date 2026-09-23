import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // These files launch Python fixtures or import the framework's built barrels.
    // Keep their process trees separate on developer desktops.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
