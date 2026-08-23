# CLI Reference

The `plumbus` CLI provides commands for scaffolding, development, governance, migrations, and AI agent integration.

## Commands at a Glance

| Command | Purpose |
|---------|---------|
| `plumbus create` | Scaffold a new Plumbus application |
| `plumbus init` | Generate AI agent wiring files |
| `plumbus dev` | Start development server with hot reload |
| `plumbus start` | Start production server (no watchers, requires `AUTH_SECRET`) |
| `plumbus worker` | Background worker process (split deployments) |
| `plumbus events` | Outbox status, dead-letter ops, event replay |
| `plumbus flow dead-letter` | List and retry failed flow executions |
| `plumbus flow schedule list` | List scheduled flows with cron and next/last run times |
| `plumbus doctor` | Check environment readiness |
| `plumbus generate` | Generate types, OpenAPI specs, manifests, and the type registry |
| `plumbus capability new` | Scaffold a new capability |
| `plumbus flow new` | Scaffold a new flow |
| `plumbus compile-flows` | Compile `defineFlow` modules into signed FlowDefinition JSON |
| `plumbus entity new` | Scaffold a new entity |
| `plumbus event new` | Scaffold a new event |
| `plumbus prompt new` | Scaffold a new prompt |
| `plumbus verify` | Run governance rules |
| `plumbus certify` | Run compliance profile assessment (`certify policy <name>`) |
| `plumbus api` | Partner API manifest validate, OpenAPI/docs export, diff |
| `plumbus voice worker` | LiveKit realtime voice worker |
| `plumbus e2e` | Run Playwright browser E2E suites |
| `plumbus migrate` | Database migration commands |
| `plumbus db` | Database lifecycle management (create, reset) |
| `plumbus rag ingest` | Ingest documents into RAG vector store |
| `plumbus run` | Run app command scripts from app/commands/ |
| `plumbus seed` | Run seed files to populate the database |
| `plumbus agent` | AI agent brief and sync commands |
| `plumbus ui` | Generate UI modules, Next.js scaffolds, and E2E test stubs |
| `plumbus browser-extension scaffold` | Scaffold a WXT Chrome/Firefox extension |
| `plumbus upgrade` | Migrate legacy artifacts after framework upgrades |
| `plumbus test` | Run tests using vitest (provided by the framework) |
| `plumbus mcp serve` | Start MCP server (stdio or HTTP) for `exposeAs: ['mcp']` capabilities |
| `plumbus mcp generate` | Generate MCP manifest and skill files only |
| `plumbus mcp list-tools` | List MCP-exposed tool names and descriptions |
| `plumbus translation new` | Scaffold a new translation catalog |
| `plumbus translation export` | Export translations to JSON or XLIFF for translators |
| `plumbus translation import` | Import translated files back into the catalog |
| `plumbus translation status` | Report translation coverage per namespace and locale |

## Installation

```bash
npm install @plumbus/core
# or
pnpm add @plumbus/core
```

The CLI is available as `plumbus` (or `npx plumbus`).

---

## Commands

### plumbus create

Scaffold a new Plumbus application.

```bash
plumbus create <app-name> [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--database <type>` | `string` | `postgresql` | Database type |
| `--auth <provider>` | `string` | `jwt` | Auth provider (`jwt`, `clerk`, `auth0`) |
| `--ai <provider>` | `string` | `openai` | AI provider (`openai`, `anthropic`) |
| `--compliance <profiles>` | `string` | — | Comma-separated compliance profiles |
| `--monorepo` | `boolean` | `false` | Scaffold a pnpm-workspace monorepo with backend, frontend, and shared libs |
| `--git` | `boolean` | `false` | Initialize git repository |
| `--skip-install` | `boolean` | `false` | Skip dependency installation |

**Example:**

```bash
plumbus create my-app --auth jwt --ai openai --compliance SOC2,GDPR --git
```

Generated structure (flat — default):

```
my-app/
├── package.json
├── tsconfig.json
├── biome.json
├── .env.example
├── .gitignore
├── README.md
├── .vscode/
│   └── settings.json
├── config/
│   ├── app.config.ts
│   └── ai.config.ts
└── app/
    ├── capabilities/
    ├── entities/
    ├── events/
    ├── flows/
    └── prompts/
```

**Monorepo mode** (`--monorepo`):

```bash
plumbus create my-app --monorepo --auth jwt --ai openai
```

```
my-app/
├── pnpm-workspace.yaml
├── package.json          # workspace root
├── tsconfig.base.json
├── biome.json
├── .gitignore            # uses **/.plumbus/generated/ glob
├── backend/
│   ├── package.json      # @my-app/backend
│   ├── tsconfig.json
│   ├── .env.example      # DB, queue, AI env vars
│   ├── config/
│   └── app/              # capabilities, entities, flows, events, prompts
├── frontend/
│   ├── package.json      # @my-app/frontend
│   ├── tsconfig.json
│   └── src/
└── libs/shared/
    ├── package.json      # @my-app/shared
    ├── tsconfig.json
    └── types/            # populated by plumbus generate
```

Cross-package dependencies use `workspace:*`. `plumbus generate` writes shared types to `libs/shared/types/`, and `plumbus ui nextjs` defaults to the `frontend/` package.

---

### plumbus init

Generate AI agent wiring files so coding agents (Copilot, Cursor, etc.) understand the framework and its mandatory guardrails.

```bash
plumbus init [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--agent <format>` | `string` | `all` | Agent format: `copilot`, `cursor`, `agents-md`, `claude`, or `all` (default generates all four) |
| `--inline` | `boolean` | `false` | Inline instructions instead of referencing files |
| `--patch` | `boolean` | `false` | Update Plumbus-managed sections and create missing files |
| `--force` | `boolean` | `false` | Replace existing generated wiring files outright |
| `--dry-run` | `boolean` | `false` | Show what would change without writing files |

**Example:**

```bash
plumbus init
plumbus init --agent copilot
plumbus init --agent cursor
plumbus init --agent agents-md
plumbus init --agent claude
plumbus init --agent all
plumbus init --patch
plumbus init --force
plumbus init --patch --dry-run
```

Files generated:

| Format | File | Purpose |
|--------|------|---------|
| `copilot` | `.github/copilot-instructions.md` | GitHub Copilot instructions |
| `cursor` | `.cursor/rules/plumbus.mdc`, `.cursor/rules/plumbus-capabilities.mdc` | Cursor rules files |
| `agents-md` | `AGENTS.md` | Generic agent instruction file |
| `claude` | `CLAUDE.md` | Claude Code instruction file (same body as `AGENTS.md`) |
| (all formats) | `.plumbus/briefs/project.md` | Project brief for `plumbus agent` |

Generated files include:

- framework-first rules that tell agents to implement business logic through Plumbus primitives
- references to the packaged SDK instruction files
- destructive git safety guidance that requires explicit user approval before discard or history-rewrite commands

Behavior by mode:

- `plumbus init` creates missing wiring files only and leaves existing files alone
- `plumbus init --patch` updates only Plumbus-managed sections and preserves surrounding custom notes
- `plumbus init --force` replaces existing generated wiring files outright
- `plumbus init --dry-run` previews the changes without writing files

Existing project briefs are preserved by `plumbus init`; use `plumbus agent sync` to refresh them.

---

### plumbus dev

Start the development server with hot reload. Runs API and worker pool colocated (default `PLUMBUS_RUNTIME_ROLE=all`) with **in-memory** queues regardless of Redis configuration.

```bash
plumbus dev [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-p, --port <number>` | `number` | — | **Required** unless `PLUMBUS_DEV_PORT` is set. Server port. No default listen port is assumed. |
| `-H, --host <string>` | `string` | `localhost` | Server host |
| `--json` | `boolean` | `false` | Output in JSON format |

Override with `PLUMBUS_RUNTIME_ROLE=api` or `worker` to test split deployments locally (Redis recommended when splitting).

---

### plumbus start

Start the production server. Unlike `plumbus dev`, this command has no watchers, forces `environment: "production"`, and fails fast if `AUTH_SECRET` is missing.

```bash
plumbus start [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-p, --port <port>` | `string` | — | **Required** unless `PLUMBUS_START_PORT` is set. Server port. No default listen port is assumed. |
| `-H, --host <host>` | `string` | `0.0.0.0` | Server host |

Behavior:

- Loads `plumbus.config.ts` with `environment: "production"` and runs `validateConfig` (fails if required env vars are missing).
- Discovers resources from `app/`, populates registries, connects to the database.
- Loads server extensions from `app/server.ts` if present (`onRoutesRegistered`, `resolveAiOverrides`, `onCapabilityError`, `onProcessError`, `onAICostRecorded`, `onFlowError`, `enableStrictStructuredOutputs`, `credentials`).
- Default runtime role is `all` (API + workers colocated). Starts a worker pool when background work is detected (events, flows with triggers/schedules, eventHandlers, jobs).
- Registers process-level handlers for `uncaughtException` / `unhandledRejection` and graceful `SIGINT` / `SIGTERM` shutdown.
- Exposes `GET /health` and `GET /ready`.
- Registers `GET /api/jobs/:jobId` for async job status polling.

Set `TRUST_PROXY=true` (or a specific IP/CIDR string) when running behind a load balancer so Fastify trusts `X-Forwarded-*` headers.

Set `PLUMBUS_RUNTIME_ROLE=api` to run API-only (no worker pool). Run `plumbus worker` in a separate process. See [Workers and Queues](../architecture/workers-and-queues.md).

---

### plumbus worker

Start a dedicated worker process for background queues, flows, and jobs. Used in split deployments alongside `PLUMBUS_RUNTIME_ROLE=api`.

```bash
plumbus worker start [options]   # default subcommand
plumbus worker status [options]
```

#### `plumbus worker start`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--health-port <port>` | `string` | — | **Required** unless `PLUMBUS_WORKER_HEALTH_PORT` is set. Health and metrics HTTP port. No default listen port is assumed. |
| `-H, --host <host>` | `string` | `0.0.0.0` | Health server bind host |

Exposes:

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness |
| `GET /ready` | Readiness (database connected) |
| `GET /metrics` | Prometheus-format metrics |

Does **not** start the main Fastify API. Requires the same `app/`, `config/`, database, and Redis configuration as the API process.

#### `plumbus worker status`

Static configuration summary (does not connect to running workers).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output JSON |

Reports `runtimeRole`, `needsWorkerPool`, `queueBackend`, `queueDurable`, `components` (dispatcher/eventWorker/jobWorker/flowRunner/scheduler/flowStepConsumer flags), and resource counts.

Worker processes expose Prometheus-style metrics at `GET /metrics` on the health port (outbox depth, delivery counters, flow step duration, capability duration).

---

### plumbus events

Operational commands for the event outbox and dead-letter queue.

```bash
plumbus events status [options]
plumbus events dead-letter list [options]
plumbus events dead-letter retry <id>
plumbus events replay <eventId> [options]
```

#### `plumbus events status`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output JSON |

Reports `outboxPending`, `deadLetterCount`, `oldestPendingAt`, `queueBackend`, and `queueDepths` (Redis only: events/flows/jobs pending+processing counts).

#### `plumbus events dead-letter list`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--limit <n>` | `string` | `20` | Max rows |
| `--json` | `boolean` | `false` | Output JSON |

#### `plumbus events dead-letter retry <id>`

Re-publish a dead-letter row to the events queue for reprocessing.

#### `plumbus events replay <eventId>`

Re-dispatch an outbox event to the queue.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--from <date>` | `string` | — | Bulk replay: re-dispatch up to 100 dispatched events from ISO date |
| `--consumer <id>` | `string` | — | Clear idempotency for this consumer before replay (single event or bulk `--from`) |

---

### plumbus compile-flows

Compile `app/flows` `defineFlow` modules into signed FlowDefinition JSON (Plan 02 Stage 5 / D-02-2). Condition expressions and step IO mappings are hoisted into digested bindings. Recompiling an identical flow yields the same `definitionDigest`.

`createServer` and `createWorkerPool` reload that directory on boot (or `compiledFlowsDirectory` / an explicit `compiledRegistry`). A tampered file whose stored digest no longer matches is refused. An empty or missing default directory leaves live TypeScript flows on.

```bash
plumbus compile-flows [--out .plumbus/compiled-flows] [--json]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-o, --out <dir>` | `string` | `.plumbus/compiled-flows` | Output directory (project-relative) |
| `--json` | `boolean` | `false` | Machine-readable list of id, version, digest, path |

### plumbus flow

Flow scaffolding and dead-letter operations.

```bash
plumbus flow new <name> [options]
plumbus flow schedule list [options]
plumbus flow dead-letter list [options]
plumbus flow dead-letter retry <executionId>
```

#### `plumbus flow schedule list`

List scheduled flows, merging code-defined `schedule.cron` values with runtime rows from `flow_schedules` (`next_run_at`, `last_run_at`, `enabled`).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output JSON (`{ "schedules": [...] }`) |

Human output includes `synced=false` for flows registered in code but not yet synced to the database (worker has not started). Synced rows show `next` and `last` ISO timestamps when present.

#### `plumbus flow dead-letter list`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--limit <n>` | `string` | `20` | Max rows |
| `--json` | `boolean` | `false` | Output JSON |

#### `plumbus flow dead-letter retry <executionId>`

Re-enqueue the next flow step for a failed execution after an operator fix.

---

### plumbus doctor

Check environment readiness — Node.js version, PostgreSQL, Redis, configuration, dependencies.

```bash
plumbus doctor [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |

Checks performed:
- Node.js version (≥ 20)
- `@plumbus/core` installed
- `@plumbus/ui` version and bundled dependency versions (next, react)
- `package.json` exists and valid
- `app.config.ts` exists
- PostgreSQL reachable
- Redis reachable
- App directory structure
- Generated agent wiring freshness (warns when generated Copilot, Cursor, `AGENTS.md`, or `CLAUDE.md` files predate the current template version)
- Legacy artifacts detection (stale `generated/`, `middleware.ts`, API proxy route)
- `mcp.agents` (warn if `@plumbus/mcp` is installed but `mcp.agents` is empty)
- `mcp.no-public-tools` (fail if any capability is both `exposeAs: ['mcp']` and `access.public: true`)
- `mcp.skill-files` (warn if generated skill files drift from current MCP-exposed capabilities)

When stale wiring is detected, doctor recommends the safest follow-up command:

- `plumbus init` for missing wiring
- `plumbus init --patch` for patchable generated wiring
- `plumbus init --force` for old or unmanaged files that cannot be safely patched

---

### plumbus upgrade

Migrate legacy artifacts and report version status after a framework upgrade. Detects stale files from previous Plumbus versions (e.g. `generated/` folder, `middleware.ts`, legacy API proxy route) and migrates them to the current layout.

```bash
plumbus upgrade [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--dry-run` | `boolean` | `false` | Show what would be migrated without making changes |

Migrations performed:
- Move `generated/*.ts` → `lib/` + `hooks/` (delete `generated/` when empty)
- Rename `middleware.ts` → `proxy.ts` and fix the exported function name
- Delete `app/api/plumbus/[...path]/route.ts` (API proxy removed)
- Rewrite `@/generated/` imports in all `.ts`/`.tsx` files
- Report current `@plumbus/ui` version and bundled dependency versions

---

### plumbus generate

Generate core derived artifacts from capability and entity definitions.

```bash
plumbus generate [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |

Generates:
- `.plumbus/generated/capability-types.ts` — `Input`/`Output` types for each capability + `CapabilityName` union
- `.plumbus/generated/openapi.json` — OpenAPI 3.1.0 for convention routes of `exposeAs: ['api']` capabilities (event handlers omitted); GET query parameters, POST bodies, and `{ data }`-wrapped 200 responses come from each capability's Zod schemas. Nullable fields use JSON Schema 2020-12 type arrays (`type: ["string", "null"]`), matching `@plumbus/api` `--openapi-version 3.1.0`
- `.plumbus/generated/manifest.json`
- `.plumbus/generated/entity-types.ts` — typed interfaces for all entities and a `DataServiceMap` for `ctx.data`
- `.plumbus/generated/plumbus.d.ts` — module augmentation that populates `PlumbusRegistry` with strict types for capability names, event names, flow names, and entity mappings
- `.plumbus/generated/mcp-manifest.json` — MCP tool manifest (only capabilities with `exposeAs: ['mcp']`)
- `.plumbus/generated/skills/<domain>/<kebab-name>.md` — agent skill files per MCP-exposed capability
- `.plumbus/generated/capability-graph.md` — Mermaid capability dependency graph
- `.plumbus/generated/consumers-manifest.json` — registered event consumers snapshot

The generated `plumbus.d.ts` file augments the `PlumbusRegistry` interface from `@plumbus/core`, providing:
- **Strict `ctx.data` access** — only defined entities autocomplete (e.g., `ctx.data.User`)
- **Typed capability names** — `capability` field in flow steps only accepts defined capability names
- **Typed event names** — `trigger.event`, wait step `event`, emit step `event`, and `ctx.events.emit()` only accept defined event names
- **Typed flow names** — `ctx.flows.start()` only accepts defined flow names

The command automatically adds `.plumbus/generated` to your `tsconfig.json`'s `include` array if it's not already present.

In **monorepo mode** (detected via `pnpm-workspace.yaml`), shared type definitions (`entity-types.ts`, `capability-types.ts`, `plumbus.d.ts`) are additionally written to `libs/shared/types/` so both backend and frontend packages can reference them.

Re-running `plumbus generate` deletes leftover `.plumbus/generated/clients/` files from older releases. Typed fetch clients and React hooks come from `plumbus ui generate`.

For frontend-ready modules and scaffolds, use `plumbus ui`.

---

### plumbus mcp

Expose MCP-exposed capabilities to AI agents. Requires `exposeAs: ['mcp']` on capabilities and `mcp.agents` in config for authentication. See [MCP overview](../mcp/overview.md).

```bash
plumbus mcp serve [--stdio] [--http] [--port <port>] [--host <host>]
plumbus mcp generate
plumbus mcp list-tools
```

`--http` requires `--port` or `PLUMBUS_MCP_PORT`. No default listen port is assumed.

| Subcommand | Description |
|------------|-------------|
| `serve` | Start MCP server; default transport is stdio when `--http` is omitted |
| `serve --http` | Streamable HTTP on `/mcp`; discovery at `GET /mcp/discovery` |
| `generate` | Write `mcp-manifest.json` and skill files under `.plumbus/generated/` |
| `list-tools` | Print MCP tool names and descriptions from current app contracts |

stdio auth uses `PLUMBUS_MCP_TOKEN`; HTTP uses `Authorization: Bearer <token>`.

---

### plumbus ui generate

Generate frontend-facing UI modules from discovered capabilities and flows.

```bash
plumbus ui generate [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--out-dir <path>` | `string` | auto-detected | Output directory: `frontend/` (or monorepo frontend) when present; otherwise `.plumbus/generated/ui` as a last-resort fallback |
| `--base-url <url>` | `string` | `""` | Prefix for generated API calls |
| `--auth-provider <provider>` | `string` | `jwt` | Auth provider used by generated auth helpers |
| `--token-key <key>` | `string` | — | Storage key for generated auth helpers |
| `--multi-tenant` | `boolean` | `false` | Include tenant helpers in auth module |
| `--include-jsdoc` | `boolean` | `false` | Emit JSDoc comments in generated modules |
| `--split-locale-bundles` | `boolean` | `false` | Emit per-locale message bundles under `i18n/locales/` (default: single `i18n/messages.ts`) |
| `--server-locale-cookie` | `boolean` | `false` | Resolve locale from the `plumbus-ui-locale` cookie in `i18n/request.ts` (dynamic rendering; not compatible with `output: 'export'`) |
| `--skip-locale-parity` | `boolean` | `false` | Skip translation coverage check before generating i18n (warns and continues; not recommended for CI) |
| `--json` | `boolean` | `false` | Output in JSON format |

Generates:
- `lib/client.ts` — typed capability clients and flow triggers
- `hooks/hooks.ts` — React hooks for capability invocation
- `lib/auth.ts` — frontend auth helpers
- `lib/form-hints.ts` — extracted form metadata from capability schemas
- `i18n/*` — messages, config (`localeSchema` / Zod-backed `isLocale`), typed keys, `TranslatedText` brand, `global.ts` AppConfig, catalog-typed `useTranslations` (`t`/`markup` → `TranslatedText`), provider, request (when translation definitions exist)

Output goes only to the resolved out-dir (`--out-dir`, or auto-detected `frontend/` / monorepo frontend). `.plumbus/generated/ui` is used solely when no frontend directory can be detected — it is not a secondary mirror of `frontend/`.

When translations are present, generate runs the same coverage check as `plumbus translation status` and exits non-zero on incomplete locales unless `--skip-locale-parity` is set.

#### Automatic legacy migration

When `plumbus ui generate` (or `plumbus ui nextjs`) detects artifacts from an older generation layout, it **auto-migrates** before writing new files:

| Legacy artifact | Migration |
|-----------------|-----------|
| `generated/client.ts` | Moved → `lib/client.ts` |
| `generated/hooks.ts` | Moved → `hooks/hooks.ts` |
| `generated/auth.ts` | Moved → `lib/auth.ts` |
| `generated/form-hints.ts` | Moved → `lib/form-hints.ts` |
| `middleware.ts` | Renamed → `proxy.ts` (export updated to `proxy`) |
| `app/api/plumbus/[...path]/route.ts` | Deleted (API proxy removed) |
| `@/generated/*` imports in `.ts`/`.tsx` | Rewritten to `@/lib/*` / `@/hooks/*` |

The migration is automatic and prints a summary of changes. Empty `generated/` directories are removed. No action is needed from the developer.

---

### plumbus ui nextjs

Scaffold a Next.js frontend app wired to generated Plumbus UI modules.

```bash
plumbus ui nextjs [output-dir] [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--app-name <name>` | `string` | current directory name | App display name |
| `--api-base-url <url>` | `string` | — | **Required** unless `NEXT_PUBLIC_API_BASE_URL` or `API_BASE_URL` is set. Absolute `http:` or `https:` API base URL. No default port is assumed. |
| `--base-url <url>` | `string` | `""` | Base URL used by generated client module |
| `--auth-provider <provider>` | `string` | `jwt` | Auth provider used by generated auth helpers |
| `--token-key <key>` | `string` | — | Storage key for generated auth helpers |
| `--multi-tenant` | `boolean` | `false` | Include tenant helpers in auth module |
| `--include-jsdoc` | `boolean` | `false` | Emit JSDoc comments in generated modules |
| `--no-auth` | `boolean` | `false` | Disable auth wiring in the scaffold |
| `--force` | `boolean` | `false` | Overwrite existing scaffold files (page.tsx, layout.tsx, etc.) |
| `--json` | `boolean` | `false` | Output in JSON format |

This command scaffolds the Next.js project structure and writes the generated UI modules into their proper locations within the output directory (`lib/client.ts`, `hooks/hooks.ts`, `lib/auth.ts`, `lib/form-hints.ts`). After scaffolding, run `plumbus ui generate` any time capabilities change — it auto-detects the frontend and regenerates the modules in place. The scaffold generates `proxy.ts` (Next.js 16+ convention) instead of the deprecated `middleware.ts`, and only generates login/signup pages (when auth is enabled) — it does not generate per-capability pages.

#### Scaffold Overwrite Protection

**Scaffold files (page.tsx, layout.tsx, globals.css, login, signup, etc.) are never overwritten if they already exist on disk.** Only contract-derived module files (`lib/client.ts`, `hooks/hooks.ts`, `lib/auth.ts`, `lib/form-hints.ts`, i18n files) are regenerated unconditionally.

If existing scaffold files are detected, the command prints a warning listing the skipped files. To force overwrite all scaffold files, pass `--force`:

```bash
plumbus ui nextjs --force        # overwrites everything, including custom pages
```

This prevents accidental destruction of custom frontend code when re-running the scaffold command.

---

### plumbus ui e2e

Scaffold Vitest + Playwright E2E test files by scanning frontend pages that use `ActionPanel`.

```bash
plumbus ui e2e [output-dir] [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--frontend-dir <dir>` | `string` | `frontend` | Frontend directory to scan |
| `--base-url <url>` | `string` | — | **Required** unless `E2E_BASE_URL` is set. Frontend base URL written into generated config. No default frontend port is assumed. |

Default output directory: `<frontend-dir>/e2e`. Run the generated suite with `plumbus e2e --config <frontend-dir>/e2e/vitest.config.e2e.ts`.

---

### plumbus browser-extension scaffold

Scaffold a WXT Chrome/Firefox extension that calls your Plumbus API with bearer tokens in `browser.storage.local`.

```bash
plumbus browser-extension scaffold [output-dir] [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--app-name <name>` | `string` | inferred from nearest `package.json` | Extension display name |
| `--api-base-url <url>` | `string` | — | **Required.** Absolute `http:` or `https:` API base URL |
| `--browser <target>` | `string` | `both` | `chrome`, `firefox`, or `both` — limits which `dev:*` / `build:*` / `zip:*` scripts are written to `package.json` |
| `--force` | `boolean` | `false` | Overwrite existing scaffold shell files |
| `--json` | `boolean` | `false` | Machine-readable result on stdout |

**Requires** `pnpm add @plumbus/ui @plumbus/browser-extension` in the app. Emits:

- Shell files (`wxt.config.ts`, `entrypoints/`, `src/auth-store.ts`, `src/invoke.ts`, …) — overwrite-protected unless `--force`
- `src/client/api.ts` — always regenerated from capabilities (absolute URLs)
- `wxt.config.ts` uses a `manifest` function so Firefox (Manifest V2) gets the API origin in `permissions` and Chrome (MV3) in `host_permissions`

See `node_modules/@plumbus/browser-extension/instructions/browser-extension.md` for auth, CORS, and access-policy prerequisites.

---

### Scaffolding Commands

```bash
plumbus capability new <name> [options]
plumbus flow new <name> [options]      # also: plumbus flow dead-letter (see above)
plumbus entity new <name>
plumbus event new <name>               # also: plumbus events status/dead-letter/replay (see above)
plumbus prompt new <name>
```

| Command | Options | Description |
|---------|---------|-------------|
| `capability new` | `--kind <type>`, `--domain <name>` | Scaffold a capability |
| `flow new` | `--domain <name>` | Scaffold a flow |
| `entity new` | — | Scaffold an entity |
| `event new` | — | Scaffold an event |
| `prompt new` | — | Scaffold a prompt |

---

### plumbus verify

Run governance rules against the application and report violations.

```bash
plumbus verify [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |

Evaluates rules across categories:
- **Security** — access policies, tenant isolation, encryption
- **Architecture** — excessive effects, flow complexity, non-canonical capability references, direct capability handler imports (source scan under `app/capabilities/`)
- **Privacy** — field classification, PII in logs, data retention
- **AI** — explainability, excessive usage, cost controls

The source scan uses the current working directory as the app root (same as `plumbus generate`).

---

### plumbus certify

Run compliance profile assessment against built-in profiles.

```bash
plumbus certify policy <name> [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |

Policy names: `pci_dss`, `gdpr`, `soc2`, `hipaa`, `internal_security_baseline`.

```bash
plumbus certify policy soc2
plumbus certify policy gdpr --json
```

---

### plumbus api

Partner API contract tooling. Requires `@plumbus/api` installed (`pnpm add @plumbus/api`). Uses `api.yaml` in the project root by default (`--manifest` overrides).

```bash
plumbus api validate [--manifest <path>] [--json] [--fail-on-governance]
plumbus api generate openapi --out <file> [--format json|yaml] [--manifest <path>]
plumbus api generate docs --out <dir> [--manifest <path>]
plumbus api diff --against <file> [--manifest <path>] [--json]
plumbus api test-fixtures validate [--json]
```

| Subcommand | Exit code | Description |
|------------|-----------|-------------|
| `validate` | 1 on findings | Manifest, policy, path params, fixtures, and advisory API governance |
| `generate openapi` | — | Write OpenAPI JSON or YAML |
| `generate docs` | — | Write Markdown API docs |
| `diff` | 1 on breaking changes | Compare current OpenAPI to a published spec |
| `test-fixtures validate` | 1 on findings | Validate fixture files against capability schemas |

---

### plumbus voice worker

Join a LiveKit room as the realtime voice agent. Requires `@plumbus/voice` and `@plumbus/voice-livekit` (`pnpm add @plumbus/voice @plumbus/voice-livekit`).

```bash
plumbus voice worker [--room <room>] [--voice <name>]
```

| Option | Type | Description |
|--------|------|-------------|
| `--room <room>` | `string` | LiveKit room to join (dev: typically a session id) |
| `--voice <name>` | `string` | Voice definition name |

Environment variables: `VOICE_AGENT_ENABLED=false` disables the worker; `VOICE_AGENT_ROOM` is used when `--room` is omitted. See [Voice](../voice/README.md).

---

### plumbus migrate

Database migration commands. **All schema changes must go through the framework — never use manual SQL DDL.**

```bash
plumbus migrate generate [options]   # Generate migration SQL from entity diffs (programmatic)
plumbus migrate apply [options]      # Apply pending migrations
plumbus migrate reconcile [options]  # Backfill migration history when schema is already in sync
plumbus migrate push [options]       # Push schema directly to DB (no migration files)
plumbus migrate rollback [options]   # Rollback last migration
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |
| `--create-db` | `boolean` | `false` | Create database if it doesn't exist (apply/push only). Does **not** create owner/runtime roles — that is `provisionDataPlane`. |
| `--database <name>` | `string` | config `database.database` | Named Postgres database to open (apply / push / rollback / reconcile). Uses `openDataPlaneConnection`. Connect as the tenant **owner** role. |
| `--dry-run` | `boolean` | `false` | Preview migrations that reconcile would mark applied (`reconcile` only) |

**Workflow:**

1. Define entities in `app/entities/` using `defineEntity()`
2. `plumbus migrate generate` — compares entity schemas against previous snapshot, writes SQL to `drizzle/`
3. `plumbus migrate apply` — executes pending migration files. For a database-per-tenant host, apply the same `drizzle/` folder to each tenant database: `plumbus migrate apply --database <name>` (config user must be the owner). Programmatic: `applyDataPlaneMigrations`. See [Tenant data planes](../sdk-reference/tenant-data-planes.md).
4. If schema already exists but migration history is missing: `plumbus migrate reconcile` — verifies the live DB already matches the current Plumbus schema, then backfills `__drizzle_migrations` without executing DDL

   On `migrate apply` / `migrate reconcile`, Plumbus automatically copies any rows from legacy `public.__drizzle_migrations` into `drizzle.__drizzle_migrations` when that legacy table exists (idempotent by hash). If the legacy table is absent — typical for fresh installs that never tracked migrations in `public` — adoption is skipped. Use the copy step after moving migration tracking from `public` into the `drizzle` schema.
5. For rapid dev: `plumbus migrate push` — diffs schemas against live DB and applies changes directly (no files)

**Never run `drizzle-kit` manually** — the framework wraps it programmatically via the `drizzle-kit/api`.

**Framework-managed tables:**

Plumbus manages 10 internal tables: `audit_records`, `event_outbox`, `event_idempotency`, `event_dead_letter`, `flow_executions`, `flow_dead_letter`, `flow_schedules`, `job_executions`, `documents`, `document_chunks`. **Do not create these tables manually** — they are included in generated migrations automatically.

**Schema drift detection:**

Both `migrate apply` and `migrate push` run a preflight check before executing. If a framework-managed table already exists in the database (e.g. from manual creation), the command fails with a drift report listing the conflicting tables and recovery steps.

For `migrate apply`, the preflight detects when a pending migration would `CREATE TABLE` for an already-existing framework table. For `migrate push`, the preflight compares existing framework table structures against the expected schema and reports column, type, or nullability mismatches.

`migrate reconcile` is the safe adoption path for the specific case where the schema is already correct and only the migration history is missing. It refuses to write history if the live database still differs from the current Plumbus schema.

**Recovery from drift:**

If you see a drift error, you have two options:
1. **Run `plumbus migrate reconcile`** if the live database already matches the current Plumbus schema and you only need to adopt the existing migration history.
2. **Fix or drop the conflicting tables** and then re-run `plumbus migrate apply` or `plumbus migrate push`.

**Statement-level diagnostics:**

When `migrate apply` fails during SQL execution, the error message includes the migration tag, statement index, and a SQL preview to pinpoint the exact failing statement.

**Rollback is history-only:**

`plumbus migrate rollback` removes the newest row from `drizzle.__drizzle_migrations`, which makes `plumbus migrate apply` run that migration again. It does **not** revert schema changes — Drizzle generates no down-migrations, so tables, columns, and indexes created by the migration stay in place. Drop or restore them manually when the schema itself must change. The command warns about this, and `--json` output includes `"schemaReverted": false` alongside the migration `tag` and `hash`.

---

### plumbus db

Database lifecycle management.

```bash
plumbus db create [options]   # Create the application database
plumbus db reset [options]    # Drop, recreate, and apply migrations
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |
| `--test` | `boolean` | `false` | Also create/reset the test database (`<dbname>_test`) |

---

### plumbus rag ingest

Ingest documents into the RAG vector store.

```bash
plumbus rag ingest <path> [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--source <name>` | `string` | — | Source identifier |
| `--tenant-id <id>` | `string` | — | Tenant scope |
| `--classification <level>` | `string` | — | Data classification |
| `--json` | `boolean` | `false` | Output in JSON format |

---

### plumbus agent

AI agent brief and sync commands.

```bash
plumbus agent brief <resource> <name> [--json]   # Generate brief for a resource
plumbus agent sync                               # Sync all agent briefs
```

| Command | Options | Description |
|---------|---------|-------------|
| `agent brief` | `--json` | Generate brief for a capability, entity, flow, event, or prompt |
| `agent sync` | — | Sync all agent briefs (no options) |

Resources: `capability`, `entity`, `flow`, `event`, `prompt`.

### plumbus test

Run tests using vitest, provided by the framework. Consumer apps should use this instead of installing vitest directly.

```bash
plumbus test                    # Run all tests once (vitest run)
plumbus test --watch            # Watch mode
plumbus test --config <path>    # Custom vitest config
plumbus test --all              # Run unit tests, then e2e (skips e2e if unit tests fail)
```

All arguments are forwarded to vitest after Plumbus normalizes the invocation for consumer apps. If you pass only options such as `--config`, Plumbus still runs Vitest in single-run mode by prepending `run`. When the config path matches an E2E config such as `frontend/e2e/vitest.config.e2e.ts`, Plumbus also adds `--configLoader runner` automatically so browser configs load correctly without a direct Vitest install in the app.

For browser suites:

```bash
plumbus e2e
plumbus e2e --config frontend/e2e/vitest.config.e2e.ts
plumbus test --config frontend/e2e/vitest.config.e2e.ts
```

---

### plumbus e2e

Run Playwright browser E2E suites via Vitest. Auto-starts the Next.js frontend dev server unless `--skip-server` is set.

```bash
plumbus e2e [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--frontend-dir <dir>` | `string` | `frontend` | Frontend package directory |
| `--port <port>` | `string` | — | **Required** unless `PLUMBUS_E2E_PORT` is set (or `--skip-server` with `--base-url`). Port for the auto-started dev server. No default listen port is assumed. |
| `--base-url <url>` | `string` | — | Base URL (skips auto server when set) |
| `--config <path>` | `string` | auto-detected | Vitest E2E config path |
| `--skip-server` | `boolean` | `false` | Do not start the frontend dev server |

Config discovery (first match wins): `frontend/e2e/vitest.config.e2e.ts`, `e2e/vitest.config.e2e.ts`, `vitest.config.e2e.ts`. When the server is started automatically, the runner waits up to 60s and sets `E2E_BASE_URL`.

**Server lifecycle safety (0.6.17+).** The auto-started dev server is resource-bounded and orphan-proof:

- **Port preflight** — if something already listens on the port (usually an orphaned server from a previous interrupted run, or another checkout's run), the command fails fast with cleanup guidance instead of silently testing against the wrong server.
- **Heap cap** — the server is spawned with `NODE_OPTIONS=--max-old-space-size=4096` (not applied when the caller already sets a `--max-old-space-size`). A runaway dev-server compile crashes the run loudly instead of exhausting machine memory.
- **Signal cleanup** — Ctrl-C / SIGTERM / SIGHUP on the CLI kills the detached server process group before exiting (previously the detached group never received the terminal's signal and survived as an immortal orphan).
- **Orphan watchdog** — a tiny detached watchdog reaps the server group if the CLI process disappears without cleanup (SIGKILL, crash, killed session): SIGTERM first, SIGKILL after a 5 s grace. It exits by itself once the server group is gone and never interferes with a normal shutdown.

---

### plumbus seed

Run seed files from `app/seeds/` to populate the database with initial data.

```bash
plumbus seed                    # Run all seed files
plumbus seed --file <name>      # Run a specific seed file
plumbus seed --json             # Output in JSON format
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--file <name>` | `string` | — | Run a specific seed file by name |
| `--json` | `boolean` | `false` | Output in JSON format |

**Seed file convention:**

Seed files live in `app/seeds/` and are executed in alphabetical order. Each file must export a `default` or named `seed` async function:

```ts
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export default async function (db: PostgresJsDatabase, schemas: Record<string, unknown>) {
  // Insert initial data using Drizzle
  await db.execute(sql`INSERT INTO ...`);
}
```

The function receives the connected Drizzle `db` instance and the collected entity `schemas` (Drizzle table objects).

---

### plumbus translation

Manage translation catalogs. Catalogs live in `app/translations/<name>.translation.ts` and are registered through `defineTranslation`.

```bash
plumbus translation new <name>
plumbus translation export [options]
plumbus translation import [options]
plumbus translation status [options]
```

#### `plumbus translation new <name>`

Scaffold a new translation catalog at `app/translations/<name>.translation.ts` populated with the default locale.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--locale-folders` | `boolean` | `false` | Scaffold per-locale message files under `en/` and `he/` with a thin assembler |

With `--locale-folders`, creates:

```
app/translations/
  en/<name>.messages.ts
  he/<name>.messages.ts
  <name>.translation.ts   # imports en + he, calls defineTranslation()
```

#### `plumbus translation export`

Export the current catalog state for handoff to external translators.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--format <format>` | `string` | `json` | Output format: `json` or `xliff` |
| `--locale <locale>` | `string` | — | Export only this locale (default: all locales) |
| `--out-dir <path>` | `string` | `.plumbus/translations` | Output directory |

Writes one file per `<locale>` (or per namespace when XLIFF) under the chosen directory.

#### `plumbus translation import`

Import a finished translation file back into the catalog. Provide exactly one of `--file` or `--dir`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--format <format>` | `string` | `json` | Source format: `json` or `xliff` |
| `--file <path>` | `string` | — | Import a single file |
| `--dir <path>` | `string` | — | Import all files from a directory |

Untranslated keys are preserved; the importer never overwrites with empty strings.

#### `plumbus translation status`

Report translation coverage. Exits non-zero when any locale is incomplete — wire it into CI to catch missing translations before release. The same coverage check runs by default during `plumbus ui generate` (unless `--skip-locale-parity`).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output as JSON for CI integration |

---

### plumbus run

Run application-defined command scripts from `app/commands/`. This lets consumer apps create custom CLI operations (user setup, data migration, cleanup tasks) using the framework's infrastructure (config, DB connection, password hashing, etc.).

```bash
plumbus run <script>                        # Run a command script
plumbus run <script> -- --arg1 value1       # Pass arguments to the script
plumbus run <script> --json                 # Output in JSON format
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |

**Command file convention:**

Command files live in `app/commands/` and are `.ts` or `.js` files. Each file must export a `default` or named `run` async function:

```ts
import { hashPassword } from "@plumbus/core";
import { randomBytes } from "node:crypto";

export default async function (ctx: { db: any; sql: any; args: string[] }) {
  // ctx.sql — raw postgres.js tagged-template connection
  // ctx.db  — Drizzle PostgresJsDatabase instance (or null if DB unavailable)
  // ctx.args — pass-through CLI arguments after --

  const password = randomBytes(24).toString("base64url");
  const hash = await hashPassword(password);

  await ctx.sql`INSERT INTO "user" (id, email, password_hash) VALUES (gen_random_uuid(), 'admin@example.com', ${hash})`;

  console.log(`Password: ${password}`);
}
```

**Example usage:**

```bash
# List available commands
plumbus run nonexistent  # Shows available command names

# Run a setup script with arguments
plumbus run setup-admin -- --email admin@company.com
```

