# Installation

## Prerequisites

| Requirement | Minimum Version | Purpose |
|-------------|----------------|---------|
| Node.js | ≥ 20 | Runtime |
| pnpm | ≥ 10 | Package manager |
| PostgreSQL | ≥ 14 | Data persistence |
| Redis | ≥ 7 (optional) | Shared event/flow/job queues for production and split deployments |
| `redis` npm package | optional peer | Required in app `package.json` when using Redis-backed queues |
| `cron-parser` npm package | optional peer | Required when flows use `schedule` triggers |
| TypeScript | ≥ 5.7 | Type system |

## Install the CLI

```bash
pnpm add -g @plumbus/core
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
✅ @plumbus/core  installed
✅ PostgreSQL    connected (localhost:5432)
✅ Redis         connected (localhost:6379)
```

## Install in an Existing Project

```bash
# Add core dependency
pnpm add @plumbus/core

# (Optional) Add UI generation package
pnpm add @plumbus/ui
```

Zod, Vitest, TypeScript, and other toolchain dependencies are provided by `@plumbus/core` — do not install them separately in consumer apps.

### Optional add-ons

Install only when you need the surface. All optional packages are explicit `pnpm add` dependencies — `@plumbus/core` does not pull them in.

| Package | Install when |
|---------|----------------|
| `@plumbus/ui` | Next.js/React UI, typed clients, scaffolds |
| `@plumbus/mcp` | Serve capabilities to AI agents (`plumbus mcp serve`) |
| `@plumbus/api` | Partner-facing HTTP API contracts (OpenAPI, manifest) |
| `@plumbus/ai-bedrock` | Amazon Bedrock chat/embeddings via `ctx.ai` (AWS SDK + IAM; not bundled in core) |
| `@plumbus/chat` | Conversational runtime (`defineChat`, policy guards) |
| `@plumbus/chat-ui` | React hooks + `<ChatPanel />` for `@plumbus/chat` |
| `@plumbus/voice` | Realtime speech I/O (`defineVoice`, routes, websocket transport) |
| `@plumbus/voice-livekit` | LiveKit transport + agent worker + browser session (peer of voice) |
| `@plumbus/voice-soniox` | Soniox STT + TTS adapter (peer of voice) |
| `@plumbus/voice-deepdub` | Deepdub TTS adapter (peer of voice) |
| `@plumbus/voice-elevenlabs` | ElevenLabs TTS adapter (peer of voice) |
| `@plumbus/voice-minimax` | MiniMax TTS adapter (peer of voice) |
| `@plumbus/knowledge-base` | Registry-backed knowledge providers for chat/RAG |
| `@plumbus/browser-extension` | Dev-time browser extension scaffolder (with `@plumbus/ui`) |
| `@plumbus/auth` | OIDC relying-party runtime (sessions, CSRF) |
| `@plumbus/auth-cognito` | Cognito hosted UI helpers for `@plumbus/auth` |
```bash
pnpm add @plumbus/chat @plumbus/chat-ui   # example: chat surface
pnpm add @plumbus/mcp                    # example: MCP agent tools
pnpm add @plumbus/ai-bedrock             # example: Amazon Bedrock (AWS SDK; IAM)
pnpm add @plumbus/voice @plumbus/voice-livekit @plumbus/voice-soniox   # example: voice stack
```

Bedrock setup (region, pricing file vs Price List auto-download, Runtime vs Mantle, why it is not in core): [Amazon Bedrock](../ai/bedrock.md).

Voice cloud providers require install **and** explicit `*_REGISTRATION` — see [Upgrading Voice Provider Packages](../upgrading-voice-provider-packages.md).
Peer ranges are version-locked — see [AGENTS.md](../../AGENTS.md) consumer dependency policy.

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
import type { PlumbusConfig } from "@plumbus/core";

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
- [Workers and Queues →](../architecture/workers-and-queues.md) — Runtime modes, split deployments, optional peers
- [Upgrading Workers →](../upgrading-workers.md) — Migrate to 0.5.0 workers/queues model

