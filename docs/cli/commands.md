# CLI Reference

The `plumbus` CLI provides commands for scaffolding, development, governance, migrations, and AI agent integration.

## Commands at a Glance

| Command | Purpose |
|---------|---------|
| `plumbus create` | Scaffold a new Plumbus application |
| `plumbus init` | Generate AI agent wiring files |
| `plumbus dev` | Start development server with hot reload |
| `plumbus doctor` | Check environment readiness |
| `plumbus generate` | Generate API clients, hooks, OpenAPI specs |
| `plumbus capability new` | Scaffold a new capability |
| `plumbus flow new` | Scaffold a new flow |
| `plumbus entity new` | Scaffold a new entity |
| `plumbus event new` | Scaffold a new event |
| `plumbus prompt new` | Scaffold a new prompt |
| `plumbus verify` | Run governance rules |
| `plumbus certify` | Run compliance profile assessment |
| `plumbus migrate` | Database migration commands |
| `plumbus db` | Database lifecycle management (create, reset) |
| `plumbus rag ingest` | Ingest documents into RAG vector store |
| `plumbus seed` | Run seed files to populate the database |
| `plumbus agent` | AI agent brief and sync commands |
| `plumbus ui` | Generate UI modules and Next.js frontends |
| `plumbus test` | Run tests using vitest (provided by the framework) |

## Installation

```bash
npm install plumbus-core
# or
pnpm add plumbus-core
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
| `--database <type>` | `string` | `postgres` | Database type |
| `--auth <provider>` | `string` | `jwt` | Auth provider (`jwt`, `clerk`, `auth0`) |
| `--ai <provider>` | `string` | — | AI provider (`openai`, `anthropic`) |
| `--compliance <profiles>` | `string` | — | Comma-separated compliance profiles |
| `--git` | `boolean` | `false` | Initialize git repository |
| `--skip-install` | `boolean` | `false` | Skip dependency installation |

**Example:**

```bash
plumbus create my-app --auth jwt --ai openai --compliance SOC2,GDPR --git
```

Generated structure:

```
my-app/
├── package.json
├── tsconfig.json
├── app.config.ts
├── ai.config.ts
├── .env.example
├── .gitignore
├── README.md
└── app/
    ├── capabilities/
    ├── entities/
    ├── events/
    ├── flows/
    └── prompts/
```

---

### plumbus init

Generate AI agent wiring files so coding agents (Copilot, Cursor, etc.) understand the framework.

```bash
plumbus init [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--agent <format>` | `string` | — | Agent format: `copilot`, `cursor`, `agents-md` |
| `--inline` | `boolean` | `false` | Inline instructions instead of referencing files |

**Example:**

```bash
plumbus init --agent copilot
plumbus init --agent cursor
plumbus init --agent agents-md
```

Files generated:

| Format | File | Purpose |
|--------|------|---------|
| `copilot` | `.github/copilot-instructions.md` | GitHub Copilot instructions |
| `cursor` | `.cursor/rules/plumbus.mdc` | Cursor rules file |
| `agents-md` | `AGENTS.md` | Generic agent instruction file |

---

### plumbus dev

Start the development server with hot reload.

```bash
plumbus dev [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-p, --port <number>` | `number` | `3000` | Server port |
| `-H, --host <string>` | `string` | `0.0.0.0` | Server host |
| `--json` | `boolean` | `false` | Output in JSON format |

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
- `plumbus-core` installed
- `package.json` exists and valid
- `app.config.ts` exists
- PostgreSQL reachable
- Redis reachable
- App directory structure

---

### plumbus generate

Generate core derived artifacts from capability definitions.

```bash
plumbus generate [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |

Generates:
- `.plumbus/generated/clients/api.ts`
- `.plumbus/generated/clients/hooks.ts`
- `.plumbus/generated/openapi.json`
- `.plumbus/generated/manifest.json`

For frontend-ready modules and scaffolds, use `plumbus ui`.

---

### plumbus ui generate

Generate frontend-facing UI modules from discovered capabilities and flows.

```bash
plumbus ui generate [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--out-dir <path>` | `string` | auto-detected | Output directory (detects `frontend/generated` if a Next.js app exists, otherwise `.plumbus/generated/ui`) |
| `--base-url <url>` | `string` | `""` | Prefix for generated API calls |
| `--auth-provider <provider>` | `string` | `jwt` | Auth provider used by generated auth helpers |
| `--token-key <key>` | `string` | — | Storage key for generated auth helpers |
| `--multi-tenant` | `boolean` | `false` | Include tenant helpers in auth module |
| `--include-jsdoc` | `boolean` | `false` | Emit JSDoc comments in generated modules |
| `--json` | `boolean` | `false` | Output in JSON format |

Generates:
- `client.ts` — typed capability clients and flow triggers
- `hooks.ts` — React hooks for capability invocation
- `auth.ts` — frontend auth helpers
- `form-hints.ts` — extracted form metadata from capability schemas

---

### plumbus ui nextjs

Scaffold a Next.js frontend app wired to generated Plumbus UI modules.

```bash
plumbus ui nextjs [output-dir] [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--app-name <name>` | `string` | current directory name | App display name |
| `--api-base-url <url>` | `string` | `http://localhost:3000` | Upstream Plumbus API base URL |
| `--base-url <url>` | `string` | `/api/plumbus` | Base URL used by generated client module |
| `--auth-provider <provider>` | `string` | `jwt` | Auth provider used by generated auth helpers |
| `--token-key <key>` | `string` | — | Storage key for generated auth helpers |
| `--multi-tenant` | `boolean` | `false` | Include tenant helpers in auth module |
| `--include-jsdoc` | `boolean` | `false` | Emit JSDoc comments in generated modules |
| `--no-auth` | `boolean` | `false` | Disable auth wiring in the scaffold |
| `--json` | `boolean` | `false` | Output in JSON format |

This command scaffolds the Next.js project structure and writes the generated UI modules (`client.ts`, `hooks.ts`, `auth.ts`, `form-hints.ts`) into `{output-dir}/generated/`. After scaffolding, run `plumbus ui generate` any time capabilities change — it auto-detects the frontend and regenerates the modules in place.

---

### Scaffolding Commands

```bash
plumbus capability new <name> [options]
plumbus flow new <name> [options]
plumbus entity new <name>
plumbus event new <name>
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
- **Architecture** — excessive effects, flow complexity
- **Privacy** — field classification, PII in logs, data retention
- **AI** — explainability, excessive usage, cost controls

---

### plumbus certify

Run compliance profile assessment against registered profiles (SOC2, GDPR, HIPAA, ISO27001).

```bash
plumbus certify [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |

---

### plumbus migrate

Database migration commands. **All schema changes must go through the framework — never use manual SQL DDL.**

```bash
plumbus migrate generate [options]   # Generate migration SQL from entity diffs (programmatic)
plumbus migrate apply [options]      # Apply pending migrations
plumbus migrate push [options]       # Push schema directly to DB (no migration files)
plumbus migrate rollback [options]   # Rollback last migration
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |
| `--create-db` | `boolean` | `false` | Create database if it doesn't exist (apply/push only) |

**Workflow:**

1. Define entities in `app/entities/` using `defineEntity()`
2. `plumbus migrate generate` — compares entity schemas against previous snapshot, writes SQL to `drizzle/`
3. `plumbus migrate apply` — executes pending migration files
4. For rapid dev: `plumbus migrate push` — diffs schemas against live DB and applies changes directly (no files)

**Never run `drizzle-kit` manually** — the framework wraps it programmatically via the `drizzle-kit/api`.

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
plumbus agent brief <resource> <name> [options]   # Generate brief for a resource
plumbus agent sync [options]                       # Sync all agent briefs
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |

Resources: `capability`, `entity`, `flow`, `event`, `prompt`.

### plumbus test

Run tests using vitest, provided by the framework. Consumer apps should use this instead of installing vitest directly.

```bash
plumbus test                    # Run all tests once (vitest run)
plumbus test --watch            # Watch mode
plumbus test --config <path>    # Custom vitest config
```

All arguments are forwarded to vitest after Plumbus normalizes the invocation for consumer apps. If you pass only options such as `--config`, Plumbus still runs Vitest in single-run mode by prepending `run`. When the config path matches an E2E config such as `frontend/e2e/vitest.config.e2e.ts`, Plumbus also adds `--configLoader runner` automatically so browser configs load correctly without a direct Vitest install in the app.

For browser suites:

```bash
plumbus e2e
plumbus e2e --config frontend/e2e/vitest.config.e2e.ts
plumbus test --config frontend/e2e/vitest.config.e2e.ts
```

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

