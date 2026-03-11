# CLI Reference

The `plumbus` CLI provides commands for scaffolding, development, governance, migrations, and AI agent integration.

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

Generate API clients, React hooks, OpenAPI specs, and manifest files from capability definitions.

```bash
plumbus generate [options]
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |

Generates:
- TypeScript API client functions
- React hooks (`useQuery`, `useMutation`)
- OpenAPI 3.1 path definitions
- Manifest JSON for each capability

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

Database migration commands.

```bash
plumbus migrate generate [options]   # Generate migration from entity changes
plumbus migrate apply [options]      # Apply pending migrations
plumbus migrate rollback [options]   # Rollback last migration
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--json` | `boolean` | `false` | Output in JSON format |

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

