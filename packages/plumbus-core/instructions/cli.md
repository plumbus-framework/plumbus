# CLI Reference

The Plumbus CLI scaffolds and manages application primitives. **Always run CLI commands from your project root** (the consumer application directory), not from the framework source.

## Project Setup

```bash
# Create a new Plumbus project (flat — default)
plumbus create <project-name> [--auth jwt|auth0|clerk] [--ai openai|anthropic] [--compliance GDPR|HIPAA] [--skip-install] [--git]

# Create a monorepo project (backend / frontend / libs)
plumbus create <project-name> --monorepo [--auth jwt|auth0|clerk] [--ai openai|anthropic] [--compliance GDPR|HIPAA] [--skip-install] [--git]

# Initialize AI agent wiring (copilot, cursor, or agents-md)
plumbus init --agent copilot

# Check project health
plumbus doctor
```

### Monorepo mode (`--monorepo`)

When `--monorepo` is passed, the generated project uses **pnpm workspaces** with three packages:

```
<project-name>/
├── pnpm-workspace.yaml
├── package.json          # private root — delegates scripts via pnpm -r
├── tsconfig.base.json
├── biome.json
├── backend/              # @<name>/backend — Plumbus app (entities, capabilities, etc.)
│   ├── package.json
│   ├── tsconfig.json
│   └── app/
├── frontend/             # @<name>/frontend — populated by `plumbus ui nextjs`
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
└── libs/shared/          # @<name>/shared — cross-package type definitions
    ├── package.json
    ├── tsconfig.json
    └── types/
```

- `plumbus generate` auto-detects the monorepo and copies shared types to `libs/shared/types/`.
- `plumbus ui nextjs` outputs into `frontend/` instead of the configured `outDir`.
- `plumbus init` adjusts AI wiring file paths to use `backend/app/` prefixes.

## Scaffolding Primitives

Use these commands to create new entities, capabilities, events, flows, and prompts. The CLI generates correctly structured files with TODOs for you to fill in.

```bash
# Create an entity
plumbus entity new <EntityName>
# → app/entities/<entity-name>.entity.ts

# Create a capability
plumbus capability new <CapabilityName>
# → app/capabilities/default/<capability-name>/capability.ts

# Create an event
plumbus event new <EventName>
# → app/events/<event-name>.event.ts

# Create a flow
plumbus flow new <FlowName>
# → app/flows/default/<flow-name>/flow.ts

# Create a prompt
plumbus prompt new <PromptName>
# → app/prompts/<prompt-name>.prompt.ts
```

Names are PascalCase on the command line and converted to kebab-case for file paths.

## Code Generation & Verification

```bash
# Generate client code, routes, and types from your contracts
plumbus generate

# Run governance checks (advisory signals, not hard blocks)
plumbus verify
plumbus verify --json
```

## Database Management

**All database operations must go through the framework. Never use manual SQL DDL queries.**

### Database Lifecycle

```bash
# Create the application database from config
plumbus db create
plumbus db create --test    # Also create <dbname>_test for testing

# Reset (drop + recreate + apply migrations)
plumbus db reset
plumbus db reset --test     # Reset the test database
```

### Migrations

```bash
# Generate migration SQL from entity definition diffs (programmatic, no drizzle-kit config needed)
plumbus migrate generate

# Apply pending migration files to the database
plumbus migrate apply
plumbus migrate apply --create-db   # Create DB if it doesn't exist, then apply

# Push schema directly to DB (no migration files — ideal for rapid dev iteration)
plumbus migrate push
plumbus migrate push --create-db

# Rollback the last applied migration
plumbus migrate rollback
```

All migration commands accept `--json` for machine-readable output.

**Workflow:**
1. Define entities in `app/entities/` using `defineEntity()`
2. Run `plumbus migrate generate` to produce SQL migration files in `drizzle/`
3. Run `plumbus migrate apply` to execute pending migrations
4. For rapid development, use `plumbus migrate push` to sync schema directly (no migration files)

**Never run `drizzle-kit` manually** — the framework wraps it programmatically.

## Development

```bash
# Start development server with hot reload
plumbus dev
```

## Production server

`plumbus start` is the production-mode counterpart to `plumbus dev`. It forces `environment: "production"`, runs `validateConfig` (which **fails fast** if `AUTH_SECRET` is missing or weak), and exposes `GET /health` + `GET /ready`.

```bash
plumbus start                      # defaults: port 3000, host 0.0.0.0
plumbus start --port 8080 --host 127.0.0.1
```

Behind a load balancer set `TRUST_PROXY=true` (or a specific IP/CIDR) so Fastify trusts `X-Forwarded-*` headers. `app/server.ts` extension hooks (`onRoutesRegistered`, `resolveAiOverrides`, `onCapabilityError`, `onProcessError`, `onAICostRecorded`, `onFlowError`, `enableStrictStructuredOutputs`) are loaded automatically.

## Translations

```bash
plumbus translation new <name>     # scaffold app/translations/<name>.translation.ts
plumbus translation export         # --format json|xliff, --locale, --out-dir
plumbus translation import         # --format json|xliff, --file or --dir
plumbus translation status         # --json for CI; exits non-zero on incomplete locales
```

Wire `plumbus translation status` into CI to catch missing translations before release.

## MCP (Model Context Protocol)

Expose capabilities marked with `exposeAs: ['mcp']` to AI agents.

```bash
# Generate MCP tool manifest and skill files (always available, no install needed)
plumbus mcp generate
# → .plumbus/generated/mcp-manifest.json
# → .plumbus/generated/skills/<domain>/<kebab-name>.md

# Run an MCP server — requires `pnpm add @plumbus/mcp` (optional peer dep)
plumbus mcp serve --stdio                        # Claude Desktop, Cursor, local agents
plumbus mcp serve --http --port 3001             # remote agents over Streamable HTTP

# Human-readable manifest dump for debugging
plumbus mcp list-tools
```

If `@plumbus/mcp` is not installed, `plumbus mcp serve` prints `Run: pnpm add @plumbus/mcp` and exits. Manifest generation works without the runtime.

Read `node_modules/@plumbus/core/instructions/mcp.md` and `node_modules/@plumbus/mcp/instructions/README.md` for MCP.

## App Commands

Run custom command scripts defined in your project's `app/commands/` directory. Use this for setup scripts, data migration tasks, and other one-off operations that need framework infrastructure (DB, config, password hashing).

```bash
# Run a command script
plumbus run <script-name>

# Pass arguments to the script
plumbus run <script-name> -- --email admin@example.com --role admin
```

Command files must export a `default` or named `run` async function receiving `{ db, sql, args }`:

```ts
import { hashPassword } from "@plumbus/core";

export default async function (ctx: { sql: any; args: string[] }) {
  const password = randomBytes(24).toString("base64url");
  await ctx.sql`INSERT INTO "user" ...`;
  console.log(`Password: ${password}`);
}
```

## Important Notes

- **Run from project root**: All commands must be executed from the consumer project directory where `package.json` lives.
- **Scaffolded files have TODOs**: After scaffolding, open the generated file and replace `// TODO` sections with your implementation.
- **`.plumbus/` is generated**: The `.plumbus/` directory contains auto-generated files. Don't edit them manually — they are regenerated by `plumbus generate`.
- **Use the framework's `define*()` functions**: Never create primitives by hand. Use the CLI to scaffold, then fill in the contracts using `defineEntity()`, `defineCapability()`, `defineFlow()`, `defineEvent()`, `definePrompt()`.
- **`plumbus ui generate` is safe to re-run**: It only regenerates contract-derived data files (`lib/client.ts`, `hooks/hooks.ts`, `lib/auth.ts`, `lib/form-hints.ts`, i18n). It never touches custom pages.
- **`plumbus ui nextjs` protects existing files**: Scaffold files (`page.tsx`, `layout.tsx`, `globals.css`, login, signup, etc.) are skipped if they already exist. Only contract-derived module files are overwritten. Use `--force` to overwrite scaffold files.
