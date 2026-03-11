# Installation

## Prerequisites

| Requirement | Minimum Version | Purpose |
|-------------|----------------|---------|
| Node.js | ≥ 20 | Runtime |
| pnpm | ≥ 10 | Package manager |
| PostgreSQL | ≥ 14 | Data persistence |
| Redis | ≥ 7 (optional) | Event queues, background jobs |
| TypeScript | ≥ 5.7 | Type system |

## Install the CLI

```bash
pnpm add -g plumbus-core
```

This installs the `plumbus` CLI binary globally.

## Create a New Project

```bash
plumbus create my-app
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--database <type>` | `postgresql` | Database engine |
| `--auth <provider>` | `jwt` | Authentication provider |
| `--ai <provider>` | `openai` | AI provider (openai, anthropic) |
| `--compliance <profiles>` | — | Comma-separated compliance profiles (GDPR, PCI-DSS, SOC2, HIPAA) |
| `--git` | — | Initialize a git repository |
| `--skip-install` | — | Skip dependency installation |

### Example

```bash
plumbus create invoice-system \
  --auth jwt \
  --ai openai \
  --compliance "GDPR,SOC2" \
  --git
```

## Verify Your Environment

```bash
cd my-app
plumbus doctor
```

The doctor command checks:

```
✅ Node.js      v20.17.0
✅ TypeScript    v5.7.3
✅ pnpm          v10.32.0
✅ package.json  found
✅ plumbus-core  installed
✅ PostgreSQL    connected (localhost:5432)
✅ Redis         connected (localhost:6379)
```

## Install in an Existing Project

```bash
# Add core dependency
pnpm add plumbus-core zod

# Add dev dependencies
pnpm add -D typescript vitest @types/node

# (Optional) Add UI generation package
pnpm add @plumbus/ui
```

### Configure TypeScript

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

### Create Application Config

```typescript
// config/app.config.ts
import type { PlumbusConfig } from "plumbus-core";

export const config: PlumbusConfig = {
  environment: "development",
  database: {
    host: process.env["DB_HOST"] ?? "localhost",
    port: Number(process.env["DB_PORT"] ?? 5432),
    database: process.env["DB_NAME"] ?? "my-app",
    user: process.env["DB_USER"] ?? "postgres",
    password: process.env["DB_PASSWORD"] ?? "",
  },
  queue: {
    host: process.env["QUEUE_HOST"] ?? "localhost",
    port: Number(process.env["QUEUE_PORT"] ?? 6379),
  },
  auth: { provider: "jwt" },
  ai: {
    provider: "openai",
    apiKey: process.env["AI_API_KEY"] ?? "",
  },
};
```

## Next Steps

- [Quick Start →](quick-start.md) — Build your first capability in 5 minutes
- [Tutorial →](tutorial.md) — Build a complete feature end-to-end

