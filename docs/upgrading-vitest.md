# Vitest 5 upgrade

Core 0.8 includes Vitest **5.0.4**, the stable npm `latest` release checked for this upgrade. All framework packages use the same version; Browser Mode uses `@vitest/browser-playwright` 5.0.4. Core also supplies Vite (`^7.3.7`) because Vitest 5 makes Vite a required peer. Consumer apps continue running `plumbus test` without installing Vitest or Vite directly.

## Node and package installation

Use Node **22.12+ on the 22.x line, 24.x, or 26+** (`^22.12.0 || ^24.0.0 || >=26.0.0`). Node 20 and odd-numbered Node 23/25 are outside the supported engine range. Update developer machines, CI, and container images before installing the core 0.8 family. `plumbus doctor` reports unsupported versions. This affects the framework package requirement because core ships Vitest as a dependency, even if a production process does not run tests.

Keep the coordinated package versions in the [stabilization guide](./upgrading-stabilization.md). The dependency upgrade is part of that unreleased family, with no additional Plumbus version bump.

## Existing test configuration

Framework `pnpm test` still defaults to two package tasks and two test workers. Use `VITEST_MAX_WORKERS` or `pnpm test -- --maxWorkers=1` to override workers; `pnpm test --concurrency=1` limits package tasks. Laya retains one worker and serial files. Vitest removed `VITEST_MAX_THREADS`, `VITEST_MAX_FORKS`, the matching minimum settings, `minWorkers`, and `poolOptions`.

For serial Node-based Playwright E2E suites, replace the old `poolOptions.forks.singleFork` configuration with:

```ts
export default {
  test: {
    include: ["**/*.e2e.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/vitest.config.*"],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
};
```

New `plumbus ui` E2E scaffolds already use these options. Existing app-owned configs are not rewritten automatically. Configs needing helpers should import `defineConfig` from `@plumbus/core/vitest`. `plumbus e2e` continues to manage the frontend and run Node-based Playwright tests through the framework's test wrapper.

Vitest Browser Mode is a separate mode: replace the string `provider: "playwright"` with `playwright()` from `@vitest/browser-playwright`, and use `vitest/browser` for browser context imports. The framework's own Browser Mode configs use this setup. Ordinary consumer Playwright E2E tests use `@plumbus/core/testing` and do not need a Browser Mode provider.

## Test behavior

Keep config files excluded: `vitest.config.e2e.ts` itself matches `**/*.e2e.ts` and otherwise fails discovery with "No test suite found". The generated config now excludes it while retaining node_modules and git exclusions.

- Vitest 5 clears mock call history before each test by default. Move per-test setup into `beforeEach`; opt into `clearMocks: false` only when a test deliberately needs shared history.
- Keep hoisted `vi.mock`, `vi.unmock`, and `vi.hoisted` calls at module scope. Use `vi.doMock` for dynamic, non-hoisted mocking.
- Constructor mocks must be constructable functions or classes, not arrow functions.
- Await asynchronous assertions, including `.resolves` and `.rejects`.
- Replace removed `test.sequential`/`describe.sequential` with `{ concurrent: false }` when required. Test-name patterns spanning suite names now use ` > ` separators.

Refresh consumer guidance with `plumbus init --patch --agent all`, then run `plumbus test` and the app's E2E checks. Keep application behavior in Plumbus primitives and framework testing helpers.

Upstream details: [Vitest 4 migration](https://v4.vitest.dev/guide/migration.html) and [Vitest 5 migration](https://vitest.dev/guide/migration/).
