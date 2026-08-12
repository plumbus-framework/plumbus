# Configuration Reference

Plumbus applications are configured through a typed `PlumbusConfig` object, loaded from environment variables and validated at startup.

## PlumbusConfig

```typescript
interface PlumbusConfig {
  environment: "development" | "staging" | "production";
  database: DatabaseConfig;
  queue: QueueConfig;
  execution?: {
    /** Global kill switch for transactional outbox (default: true). Env: PLUMBUS_TRANSACTIONAL_OUTBOX=false */
    transactionalOutbox?: boolean;
  };
  ai?: AIProviderConfig;               // Single provider (legacy)
  aiProviders?: AIProvidersConfig;      // Multi-provider (takes precedence)
  auth: AuthAdapterConfig;
  complianceProfiles?: string[];
  mcp?: McpConfig;                      // Optional MCP agent registry
}
```

## MCP Configuration

`mcp.agents` registers tokens that AI agents present to call `exposeAs: ['mcp']` capabilities. Required only when serving MCP — `@plumbus/core` works without `@plumbus/mcp` installed.

```typescript
interface McpConfig {
  agents?: Record<string, McpAgentConfig>;
}

interface McpAgentConfig {
  serviceAccountId: string;
  scopes: string[];
  tenantId?: string;
}
```

Each map key is the verbatim Bearer token the agent presents (either over HTTP `Authorization: Bearer <key>` or as `PLUMBUS_MCP_TOKEN` for stdio). Pick a high-entropy string — there is no separate "secret" field.

```typescript
mcp: {
  agents: {
    "sk-billing-agent-7c2f9": {
      serviceAccountId: "billing-agent",
      scopes: ["billing:read"],
      tenantId: "tenant-uuid",
    },
  },
}
```

When `mcp.agents` is empty or unset, `plumbus mcp serve` falls back to the JWT adapter and only `access.public: true` capabilities are callable. See [MCP agent authentication](../mcp/agent-authentication.md) for the full security model.

Per-call observability: see [MCP transports → onMcpToolCall](../mcp/transports.md#per-tool-call-observability--onmcptoolcall).

### Required entity for MCP-exposed jobs

Apps that expose `kind: 'job'` capabilities via MCP must register `mcpTaskEntity` in their entity list:

```ts
import { mcpTaskEntity } from '@plumbus/mcp';

export const entities = [
  // ... your own entities ...
  mcpTaskEntity,
];
```

Without it, `tasks/*` calls will fail because there is no table to store task state. See [tasks-and-jobs.md](../mcp/tasks-and-jobs.md).

## Database Configuration

```typescript
interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  poolSize?: number;
}
```

Environment variables:

```bash
DB_HOST=localhost          # aliases: DATABASE_HOST, PGHOST
DB_PORT=5432               # aliases: DATABASE_PORT, PGPORT
DB_NAME=myapp              # aliases: DATABASE_NAME, PGDATABASE
DB_USER=postgres           # aliases: DATABASE_USER, PGUSER
DB_PASSWORD=secret         # aliases: DATABASE_PASSWORD, PGPASSWORD
DATABASE_SSL=false         # read when DATABASE_SSL=true
DATABASE_POOL_SIZE=10
```

## Runtime Role

Control which subsystems start in the current process:

```bash
PLUMBUS_RUNTIME_ROLE=all     # API + workers (default for plumbus dev / plumbus start)
PLUMBUS_RUNTIME_ROLE=api      # API only — run plumbus worker separately
PLUMBUS_RUNTIME_ROLE=worker   # Workers only (implicit for plumbus worker)
```

See [Workers and Queues](../architecture/workers-and-queues.md).

## Queue Configuration

```typescript
interface QueueConfig {
  host: string;
  port: number;
  password?: string;
  prefix?: string;
  visibilityTimeoutSec?: number;  // Redis visibility timeout (default 30)
}
```

Environment variables:

```bash
QUEUE_HOST=localhost
QUEUE_PORT=6379
QUEUE_PASSWORD=
QUEUE_PREFIX=plumbus
QUEUE_URL=redis://localhost:6379    # preferred — also REDIS_URL
QUEUE_BACKEND=redis                 # force memory or redis
```

The runtime creates three logical queues (`events`, `flows`, `jobs`) sharing the same backend. `plumbus dev` always uses in-memory queues regardless of Redis configuration.

## Optional Peer Dependencies

Install only when your deployment needs them:

| Package | Purpose |
|---------|---------|
| `redis` | Durable shared queues for production / split deployments |
| `cron-parser` | Flow `schedule` trigger `nextRunAt` computation |
| `@plumbus/mcp` | MCP server and MCP job completion sync in workers |
| `@plumbus/api` | Partner API contract layer |
| `@plumbus/ai-bedrock` | Amazon Bedrock adapter (AWS SDK; not bundled in core) |

```bash
pnpm add redis cron-parser
```

## AI Provider Configuration

### Single Provider (Legacy)

```typescript
interface AIProviderConfig {
  provider: string;        // "openai" | "anthropic" | "bedrock" | …
  apiKey: string;          // openai/anthropic key; "" for bedrock (IAM auth)
  model?: string;
  baseUrl?: string;
  region?: string;         // bedrock
  pricingFilePath?: string; // bedrock — mounted rates JSON
  embeddingModel?: string;  // bedrock
  pricingCacheTtlMs?: number;
  maxTokensPerRequest?: number;
  dailyCostLimit?: number;
  requestTimeout?: number; // default 120_000 ms
}

// Accepted by createProviderAdapter — same shape with an optional apiKey, so
// keyless providers need no placeholder. AIProviderConfig is assignable to it.
type AIProviderSlotConfig = Omit<AIProviderConfig, 'apiKey'> & { apiKey?: string };
```

`apiKey` stays required on `AIProviderConfig` so app bootstrap can keep doing:

```typescript
if (config.ai) createOpenAIAdapter({ apiKey: config.ai.apiKey }); // still a `string`
```

Environment variables:

```bash
AI_PROVIDER=openai
AI_API_KEY=sk-...
AI_MODEL=gpt-4o-mini
AI_BASE_URL=
AI_MAX_TOKENS=4096
AI_DAILY_COST_LIMIT=50
AI_REQUEST_TIMEOUT=120000
```

### Multi-Provider

Register multiple AI providers and route prompts to the appropriate one.

```typescript
interface AIProvidersConfig {
  defaultProvider: string;
  defaultModel?: string;
  providers: Record<string, AIProviderConfig>;
  promptOverrides?: Record<string, PromptModelOverride>;
}

interface PromptModelOverride {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}
```

Environment variables follow the pattern `AI_{PROVIDER}_*`:

```bash
AI_DEFAULT_PROVIDER=openai
AI_DEFAULT_MODEL=gpt-4o          # fallback model for all prompts

# OpenAI
AI_OPENAI_API_KEY=sk-...
AI_OPENAI_MODEL=gpt-4o-mini
AI_OPENAI_BASE_URL=             # optional — custom endpoint
AI_OPENAI_MAX_TOKENS=4096
AI_OPENAI_DAILY_COST_LIMIT=50
AI_OPENAI_REQUEST_TIMEOUT=120000

# Anthropic
AI_ANTHROPIC_API_KEY=ant-...
AI_ANTHROPIC_MODEL=claude-sonnet-4-20250514
AI_ANTHROPIC_BASE_URL=           # optional — custom endpoint
AI_ANTHROPIC_MAX_TOKENS=4096
AI_ANTHROPIC_DAILY_COST_LIMIT=50
AI_ANTHROPIC_REQUEST_TIMEOUT=120000

# Amazon Bedrock (requires: pnpm add @plumbus/ai-bedrock)
# Auth is IAM / IRSA — no API key. Cost from Price List or mounted file.
AI_BEDROCK_REGION=us-east-1
AI_BEDROCK_MODEL=anthropic.claude-sonnet-4-5-20250929-v1:0
AI_BEDROCK_EMBEDDING_MODEL=amazon.titan-embed-text-v2:0
# AI_BEDROCK_PRICING_FILE=/config/bedrock-pricing.json   # recommended in k8s
# AI_BEDROCK_PRICING_TTL_MS=86400000
# AI_BEDROCK_REQUEST_TIMEOUT=120000
```

Env discovery supports **`AI_OPENAI_*`**, **`AI_ANTHROPIC_*`**, and **`AI_BEDROCK_*`**. Other `AI_{NAME}_API_KEY` values are ignored with a warning. Wire Ollama / custom providers programmatically via `createOpenAIAdapter` / `createAIService`. Bedrock lives in a separate package because it needs the AWS SDK — see [Amazon Bedrock](../ai/bedrock.md).

### Per-Prompt Overrides

Override model, provider, temperature, or maxTokens for any specific prompt via env vars:

```bash
# Format: PROMPT_{NAME}_{FIELD}
# Name = prompt name with dots replaced by underscores, UPPERCASED
# Fields: PROVIDER, MODEL, TEMPERATURE, MAX_TOKENS

PROMPT_WRITER_WRITE_CHAPTER_PROVIDER=anthropic
PROMPT_WRITER_WRITE_CHAPTER_MODEL=claude-sonnet-4-20250514
PROMPT_INTERVIEW_EXTRACT_METADATA_MODEL=gpt-4o-mini
```

### Model Resolution Chain

When a prompt is invoked, model and provider are resolved in this order:

1. **Per-prompt env override** (`PROMPT_{NAME}_MODEL`) — highest priority
2. **Prompt definition** (`model.name` in `definePrompt`) — if set
3. **Default model** (`AI_DEFAULT_MODEL`) — global fallback

Provider resolution: per-prompt override → prompt definition → `AI_DEFAULT_PROVIDER`.

When `aiProviders` is configured in `PlumbusConfig`, it takes precedence over the legacy single `ai` field.

### AI security (opt-in)

Classified-field scanning runs only when `aiProviders.security` is set in config or via env vars below. Omit the block to leave AI calls without entity classification checks (capability `access` policies still apply).

```typescript
interface AIProvidersConfig {
  defaultProvider: string;
  providers: Record<string, AIProviderConfig>;
  security?: {
    mode?: "redact" | "block"; // default redact when security is configured
    warnThreshold?: FieldClassification;
    redactThreshold?: FieldClassification;
    entities?: EntityDefinition[]; // auto-populated from registry when security is active
  };
}
```

Environment variables:

```bash
PLUMBUS_TRANSACTIONAL_OUTBOX=false   # disable transactional outbox globally (default: true)

AI_SECURITY_MODE=redact
AI_SECURITY_WARN_THRESHOLD=sensitive
AI_SECURITY_REDACT_THRESHOLD=highly_sensitive
```

### Field encryption

Set `PLUMBUS_ENCRYPTION_KEY` (32-byte hex or base64) to enable AES-256-GCM encryption for entity fields marked `encrypted: true`. Without the key, repositories store and return plaintext (legacy behavior).

```bash
PLUMBUS_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

## Auth Configuration

```typescript
interface AuthAdapterConfig {
  provider: string;    // "jwt" | "clerk" | "auth0" | "custom"
  issuer?: string;
  audience?: string;
  jwksUri?: string;
  secret?: string;
}
```

Environment variables:

```bash
AUTH_PROVIDER=jwt
AUTH_ISSUER=https://auth.example.com
AUTH_AUDIENCE=my-api
AUTH_JWKS_URI=https://auth.example.com/.well-known/jwks.json
AUTH_SECRET=
```

## Loading Configuration

```typescript
import { loadConfig, validateConfig } from "@plumbus/core";

// Load from environment
const config = loadConfig();

// Load with explicit environment
const config = loadConfig({ environment: "production" });

// Load with custom env vars
const config = loadConfig({ env: process.env });

// Validate
const result = validateConfig(config);
if (!result.valid) {
  console.error("Config errors:", result.errors);
}
if (result.warnings.length > 0) {
  console.warn("Config warnings:", result.warnings);
}
```

### ConfigValidationResult

```typescript
interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
```

## Example Configuration File

```typescript
// app.config.ts
export default {
  environment: "development",
  database: {
    host: "localhost",
    port: 5432,
    database: "myapp_dev",
    user: "postgres",
    password: "postgres",
    poolSize: 5,
  },
  queue: {
    host: "localhost",
    port: 6379,
    prefix: "myapp",
  },
  auth: {
    provider: "jwt",
    secret: "dev-secret-change-in-production",
  },
  ai: {
    provider: "openai",
    apiKey: process.env["OPENAI_API_KEY"]!,
    model: "gpt-4o-mini",
    dailyCostLimit: 10,
  },
  // Or use multi-provider:
  // aiProviders: {
  //   defaultProvider: "openai",
  //   providers: {
  //     openai: { apiKey: process.env["OPENAI_API_KEY"]!, model: "gpt-4o-mini" },
  //     anthropic: { apiKey: process.env["ANTHROPIC_API_KEY"]!, model: "claude-sonnet-4-20250514" },
  //   },
  // },
  complianceProfiles: ["soc2", "gdpr"],
};
```

## Server Configuration

The `createServer()` function accepts a `ServerConfig`:

```typescript
interface ServerConfig {
  config: PlumbusConfig;
  db: PostgresJsDatabase;
  capabilities: CapabilityRegistry;
  entities: EntityRegistry;
  events: EventRegistry;
  consumers: ConsumerRegistry;
  flows: FlowRegistry;
  translations?: TranslationDefinition[];
  promptRegistry?: PromptRegistry;
  authAdapter?: AuthAdapter;
  logger?: LoggerService;
  host?: string;           // Default: "0.0.0.0"
  port?: number;           // Default: 3000
  trustProxy?: boolean | string | string[] | number;
  jobQueue?: EventQueue;
  metrics?: PlumbusMetrics;
  onRoutesRegistered?: (app, routeConfig) => void;
  onCapabilityError?: (info) => void | Promise<void>;
  onProcessError?: (info) => void | Promise<void>;
  resolveAiOverrides?: (db) => Promise<{ defaultModel?; defaultProvider?; promptOverrides? }>;
  onAICostRecorded?: (record, costContext, db) => void | Promise<void>;
  enableStrictStructuredOutputs?: boolean;
}
```

### `onCapabilityError` Hook

Optional fire-and-forget callback invoked whenever a capability returns a failure result. The hook runs **after** the error response is sent to the client, so it never delays the HTTP response. Any errors thrown by the hook are silently swallowed.

Export an `onCapabilityError` function from `app/server.ts` and the CLI will wire it automatically:

```typescript
// app/server.ts
import type { ServerConfig } from "@plumbus/core";

export const onCapabilityError: NonNullable<ServerConfig['onCapabilityError']> = async (info) => {
  // info contains: capabilityName, domain, errorCode, errorMessage,
  //                metadata?, userId?, tenantId?, sourceIp?, userAgent?, db?
  await writeToMyErrorTable(info);
};
```

When the server is already connected to PostgreSQL, the same live Drizzle connection is also passed into framework callbacks and custom route hooks. Consumer apps can use that `db` handle instead of opening a second ad hoc database client from `app/server.ts`.

When `createServer()` is started through `plumbus dev` or `plumbus start`, the framework also binds discovered `app/translations/*` catalogs into each HTTP execution context. That means generated capability routes and custom `app/server.ts` routes can safely call `ctx.translations.t('errors.someKey')` without falling back to the raw translation key.

> **Production requirement:** `auth.secret` must be set when `environment` is `"production"`. The server will throw on startup if no secret is configured in production. In development/staging, a fallback secret is used with a warning.

The server wires capability routes automatically. Event consumers, flow triggers, and entity repositories are the caller's responsibility to wire into the application lifecycle.

```typescript
import { createServer, loadConfig } from "@plumbus/core";

const server = createServer({
  config: loadConfig(),
  db,
  capabilities: capabilityRegistry,
  entities: entityRegistry,
  events: eventRegistry,
  consumers: consumerRegistry,
  flows: flowRegistry,
  promptRegistry,
  port: 3000,
});

await server.start();
```

## Worker Pool Configuration

The worker pool starts automatically when the server boots via `plumbus dev` or `plumbus start`. If any registered flows have event triggers, the framework creates an in-memory queue, registers flow trigger consumers, and starts the background workers (outbox dispatcher, event worker, flow runner, flow scheduler).

No manual wiring is required. The following config options are available when using `createWorkerPool()` directly:

```typescript
interface WorkerPoolConfig {
  config: PlumbusConfig;
  db: PostgresJsDatabase;
  queue: EventQueue;
  jobsQueue?: EventQueue;
  flowsQueue?: EventQueue;
  queuesDurable?: boolean;
  consumers: ConsumerRegistry;
  flows: FlowRegistry;
  stepDeps: StepExecutorDeps;
  capabilities?: CapabilityRegistry;
  entities?: EntityRegistry;
  createDataService?: (auth?: AuthContext) => DataService;
  eventRegistry?: EventRegistry;
  aiService?: AIService;
  audit?: AuditService;
  logger?: LoggerService;
  metrics?: PlumbusMetrics;
  onMcpJobComplete?: (jobId, result, payload?, error?) => Promise<void>;
  onFlowError?: (info) => void | Promise<void>;
  outboxPollIntervalMs?: number;      // Default: 1000
  schedulerPollIntervalMs?: number;   // Default: 60000
  flowPollIntervalMs?: number;        // Default: 1000
  enableDispatcher?: boolean;         // Default: true
  enableEventWorker?: boolean;        // Default: true
  enableScheduler?: boolean;          // Default: true
  enableFlowRunner?: boolean;         // Default: true
  flowLeaseDurationMs?: number;       // Default: 300000 (5 min)
  flowHeartbeatIntervalMs?: number;   // Default: flowLeaseDurationMs / 3
  flowClaimBatchSize?: number;        // Default: 50
}
```

Additional hooks (`onQueuesClose`, `redisClient`, `flowsPrefix`, `refreshQueueDepths`, `onFlowStepEnqueue`) are available for durable split deployments — see `packages/plumbus-core/src/worker/bootstrap.ts`.

The pool auto-registers a `plumbus:flow-trigger` consumer that maps incoming events to flow starts via `createFlowTriggerHandler`.

### Flow lease tuning

The flow runner uses lease-based row claiming (`FOR UPDATE SKIP LOCKED`) so multiple workers sharing the same database never execute the same step twice. The defaults are suitable for most deployments; tune these only when you have a specific reason to.

- **`flowLeaseDurationMs`** (default `300_000` = 5 min) — Upper bound on how long a worker can hold a claim without heartbeating. If a worker crashes, another worker can reclaim the row after this window elapses. Raise it if you run steps longer than the heartbeat interval can reliably cover (e.g. suspended VMs, long GC pauses); lower it to reduce crash-recovery latency.
- **`flowHeartbeatIntervalMs`** (default `flowLeaseDurationMs / 3`) — How often a running worker automatically extends its lease. The 3× safety margin tolerates two missed ticks before the lease is considered expired.
- **`flowClaimBatchSize`** (default `50`) — Max executions a single `claimNext()` poll cycle will lock. Larger batches amortize the poll cost; smaller batches spread work more evenly across workers.
- **Worker identity** — Each worker auto-generates a unique `workerId` of the form `<hostname>:<pid>:<short-uuid>` via `generateWorkerId()`. The pool does not expose a `workerId` knob on `WorkerPoolConfig`; if you need stable identity for observability, pass a `workerId` directly when constructing the engine with `createFlowEngine()`.

