# Configuration Reference

Plumbus applications are configured through a typed `PlumbusConfig` object. CLI startup loads `config/app.config.ts`, `.js`, or `.mjs` and merges defaults < file < environment < explicit options. CLI-forced development/production mode wins. Unknown keys and invalid settings fail validation.

## PlumbusConfig

```typescript
interface PlumbusConfig {
  environment: "development" | "staging" | "production";
  database: DatabaseConfig;
  queue: QueueConfig;
  workers?: { enableScheduler?: boolean; eventDelivery?: EventDeliveryOptions };
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
DATABASE_SSL=true          # TLS to Postgres; production defaults to true, false turns it off
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
  url?: string;
  backend?: "memory" | "redis";
  pollIntervalMs?: number;
  reclaimIntervalMs?: number;
  startupTimeoutMs?: number;
  operationTimeoutMs?: number;
  shutdownTimeoutMs?: number;
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

The runtime creates three logical queues (`events`, `flows`, `jobs`) sharing the same backend. `plumbus dev` always uses in-memory queues regardless of Redis configuration. Once Redis is selected outside that deliberate development mode, connection/driver failures fail startup; runtime disconnects never switch to memory. Redis readiness covers API and worker processes wired by the CLI.

Timing environment variables are `QUEUE_VISIBILITY_TIMEOUT_SEC`, `QUEUE_POLL_INTERVAL_MS`, `QUEUE_RECLAIM_INTERVAL_MS`, `QUEUE_STARTUP_TIMEOUT_MS`, and `QUEUE_OPERATION_TIMEOUT_MS`. Configure `shutdownTimeoutMs` through the file or programmatic options. Timings must be positive.

### Event delivery and scheduler activation

```typescript
workers: {
  enableScheduler: true, // PLUMBUS_ENABLE_SCHEDULER=false disables it during cutover
  eventDelivery: {
    retry: { maxAttempts: 3, backoff: "exponential", baseDelayMs: 1000, maxDelayMs: 30000 },
    unrouted: "deadLetter", // default; "acknowledge" is explicit legacy behavior
    ignoredEventTypes: [], // intentionally unhandled event types
  },
}
```

`maxAttempts` counts total calls. A capability's `trigger.retry` overrides the pool policy. Legacy event `maxRetries`/`defaultMaxRetries` also count total calls; legacy flow `retry.attempts` counts retries after the initial call. Do not combine aliases. All workers sharing a queue must have compatible consumer registries; these options do not route between specialized pools.

## Optional Peer Dependencies

Install only when your deployment needs them:

| Package | Purpose |
|---------|---------|
| `redis` | Durable shared queues for production / split deployments |
| `@plumbus/mcp` | MCP server and MCP job completion sync in workers |
| `@plumbus/api` | Partner API contract layer |
| `@plumbus/ai-bedrock` | Amazon Bedrock adapter (AWS SDK; not bundled in core) |

```bash
pnpm add 'redis@^4.7.0'
```

Core 0.8 owns the supported cron parser as a dependency; consumers do not install it.

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
  cache?: boolean | { system?: boolean; tools?: boolean; messages?: boolean }; // prompt-cache default (single-provider `ai` only)
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
AI_PROMPT_CACHE=true            # optional — see Prompt caching below
```

### Multi-Provider

Register multiple AI providers and route prompts to the appropriate one.

```typescript
interface AIProvidersConfig {
  defaultProvider: string;
  defaultModel?: string;
  providers: Record<string, AIProviderConfig>;
  promptOverrides?: Record<string, PromptModelOverride>;
  cache?: boolean | { system?: boolean; tools?: boolean; messages?: boolean }; // prompt-cache default
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
AI_PROMPT_CACHE=true             # optional — Anthropic / Bedrock prompt-cache default

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

`*_REQUEST_TIMEOUT` (whole ms, 1–2147483647), `*_MAX_TOKENS` (whole tokens, ≥ 0), `*_DAILY_COST_LIMIT` (USD, ≥ 0) and `AI_BEDROCK_PRICING_TTL_MS` (whole ms, ≥ 0) take plain numbers, no unit suffixes; anything else (`15m`, `4k`, `abc`) makes `loadConfig()` throw naming the variable. The same holds for `AI_MAX_TOKENS`, `AI_DAILY_COST_LIMIT` and `AI_REQUEST_TIMEOUT` in single-provider mode.

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

When a prompt is invoked, each field (`provider`, `model`, `temperature`, `maxTokens`, `reasoning`, `timeoutMs`) is resolved on its own, first set wins:

1. **Per-call value** (`provider`, `model`, `reasoning`, `timeoutMs` on `generate` / `generateWithUsage` / `streamGenerate`)
2. **Dynamic override** (`ServerConfig.resolveAiOverrides` → `promptOverrides`, keyed by prompt name or env-style key; the name wins)
3. **Per-prompt env override** (`PROMPT_{NAME}_*`)
4. **Prompt definition** (`model` in `definePrompt`) — if set
5. **Defaults** — `resolveAiOverrides` → `defaultModel` / `defaultProvider`, else `AI_DEFAULT_MODEL` / `AI_DEFAULT_PROVIDER`

A layer decides only the fields it sets, so a dynamic `{ model }` keeps the prompt's env `MAX_TOKENS` and `TIMEOUT_MS`. See [AI integration](../ai/ai-integration.md#configuration-and-model-resolution).

When `aiProviders` is configured in `PlumbusConfig`, it takes precedence over the legacy single `ai` field.

### Prompt caching (core 0.7.9+)

`AI_PROMPT_CACHE` sets the default `cache` option for every Anthropic / Bedrock call. `loadConfig()` stores it as `aiProviders.cache`, and as `ai.cache` in single-provider mode. The API server and workers pass it to `createAIService({ cache })`; a `cache` set on a call (or on `runToolLoop`) overrides it. Slots under `aiProviders.providers` do not read `cache`.

```bash
AI_PROMPT_CACHE=true                   # system prompt + tools
AI_PROMPT_CACHE=system,tools,messages  # any comma-separated subset
AI_PROMPT_CACHE=false                  # off (same as unset)
```

Any other value logs a warning and leaves caching off. What each section marks, and which models skip it, is in [Prompt caching](../ai/ai-integration.md#prompt-caching-anthropic--bedrock).

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
import { loadAppConfig, loadConfig, validateConfig } from "@plumbus/core";

// Load from environment
const config = loadConfig();

// Load with explicit environment
const productionConfig = loadConfig({ environment: "production" });

// Load with custom env vars
const customEnvConfig = loadConfig({ env: process.env });

// Merge a validated nested override
const prefixedConfig = loadConfig({ queue: { prefix: "myapp" } });

// Load the application file as CLI startup does
const appConfig = await loadAppConfig();

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
// config/app.config.ts (or backend/config/app.config.ts in a monorepo)
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
    apiKey: process.env["OPENAI_API_KEY"] ?? "",
    model: "gpt-4o-mini",
    dailyCostLimit: 10,
  },
  // Or use multi-provider:
  // aiProviders: {
  //   defaultProvider: "openai",
  //   providers: {
  //     openai: { apiKey: process.env["OPENAI_API_KEY"] ?? "", model: "gpt-4o-mini" },
  //     anthropic: { apiKey: process.env["ANTHROPIC_API_KEY"] ?? "", model: "claude-sonnet-4-20250514" },
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
  aiProviderConcurrency?: AIProviderConcurrencyConfig;
  resolveAIProviderHeaders?: (context) => Record<string, string> | Promise<Record<string, string>>;
  onAIProviderSpan?: (span: AIProviderSpan) => void | Promise<void>;
  enableStrictStructuredOutputs?: boolean;
  credentials?: CredentialCatalog;
}
```

### AI provider admission and trace hooks

`aiProviderConcurrency`, `resolveAIProviderHeaders` and `onAIProviderSpan` wrap every real provider attempt made through `ctx.ai` (validation retries and streams included). Export them from `app/server.ts` and `plumbus dev` / `start` / `worker` wire them into the request AI service and the worker pool alike; `createAIService` accepts the same three as `providerConcurrency`, `resolveProviderHeaders` and `onProviderSpan`. The concurrency ceiling is an immediate per-scope admission (provider + tenant + `costContext.serviceArea` unless `resolveScope` says otherwise) shared by every identity-bound service, and saturation throws `ai-provider-concurrency-exhausted` rather than queueing. Header resolution feeds `ProviderRequest.transportHeaders` and refuses credential and content-type headers. Span export is best effort: a throwing hook never changes the model-call result. See [AI integration](../ai/ai-integration.md#provider-admission-and-trace-propagation).

### `onCapabilityError` Hook

Optional fire-and-forget callback invoked whenever a capability returns a failure result: from an HTTP route, a flow step, a job, or an event handler. HTTP routes call it **after** the error response is sent, so it never delays the response. In the worker it never changes what happens next: event retries and dead-lettering, the job's failed status, and flow step retries and `onFlowError` run as before. Errors thrown or rejected by the hook are logged (`[plumbus] Hook "onCapabilityError" failed: …`) and never propagate.

Export an `onCapabilityError` function from `app/server.ts` and `plumbus dev`, `plumbus start`, and `plumbus worker` wire it into whichever of the API and the worker pool they run:

```typescript
// app/server.ts
import type { ServerConfig } from "@plumbus/core";

export const onCapabilityError: NonNullable<ServerConfig['onCapabilityError']> = async (info) => {
  // info contains: capabilityName, domain, errorCode, errorMessage,
  //                metadata?, userId?, tenantId?, sourceIp?, userAgent?, db?, source?
  await writeToMyErrorTable(info);
};
```

The payload type is exported as `CapabilityErrorInfo`. `source` tells you where the capability ran:

| `source` | Where | `userId` / `tenantId` |
|----------|-------|-----------------------|
| `'http'` | Generated HTTP route | The caller; `sourceIp` and `userAgent` come from the request |
| `'flow'` | Flow step (including parallel branches) | The caller stored when the flow started |
| `'job'` | `kind: 'job'` capability run by the worker | The caller stored when the job was queued |
| `'event'` | `kind: 'eventHandler'` capability run by the worker | The handler's first service account (or `event-worker`) and the event's tenant |

`sourceIp` and `userAgent` are always undefined outside HTTP. With tenant data planes,
`db` is the request's resolved database for HTTP failures and the executing unit's
resolved database for worker failures; a flow hook receives the plane selected for
the initiating identity. This also applies to failures of HTTP capabilities using
idempotency. See [Tenant Data Planes](tenant-data-planes.md).

The worker reports each failed attempt. An event handler that fails on all N delivery attempts fires the hook N times before the event is dead-lettered, and a flow step retried through the flow's `retry.attempts` fires once per failed attempt. A failed job fires once: it is marked failed and not run again. A step that fails after its flow was cancelled, or after its lease moved to another worker, is not reported: the engine discards that attempt.

Only failures returned by the capability pipeline are reported: input validation, access policy, handler errors, and invalid output. Rejections before the capability runs are not: HTTP authentication failures, the input and access checks before an HTTP job is queued, the event-handler and job consumers' own payload and access checks, and a flow step that names an unknown capability or a job. Nested `ctx.capabilities.invoke()` calls do not fire the hook. MCP tool calls are not covered either; `@plumbus/mcp` has its own `onCapabilityError`. Neither are routes registered by `@plumbus/api` `registerApiRoutes()`.

`createServer()` covers HTTP routes only. With your own bootstrap, pass the same function to `createWorkerPool({ onCapabilityError })` for flow steps, jobs, and event handlers. Flow steps are reported when `stepDeps` comes from `buildStepDeps()`. Jobs and event handlers are reported when `createWorkerPool()` registers their consumers (`capabilities`, `entities`, and `eventRegistry` set); if you call `registerCapabilityConsumers()` yourself, pass `onCapabilityError` to it.

When the server is already connected to PostgreSQL, the same live Drizzle connection is also passed into framework callbacks and custom route hooks. Consumer apps can use that `db` handle instead of opening a second ad hoc database client from `app/server.ts`.

When `createServer()` is started through `plumbus dev` or `plumbus start`, the framework also binds discovered `app/translations/*` catalogs into each HTTP execution context. That means generated capability routes and custom `app/server.ts` routes can safely call `ctx.translations.t('errors.someKey')` without falling back to the raw translation key.

> **Authentication requirement:** outside development, supply `auth.secret`, a custom `authAdapter`, or an `authenticationRuntime` (for example `@plumbus/auth`). With none configured, staging/production startup fails. Development without authentication wiring is anonymous with a warning; no fallback JWT secret is created.

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
  port: Number(process.env.PLUMBUS_START_PORT),
});

await server.start();
```

## Worker Pool Configuration

CLI startup (`plumbus dev` / `plumbus start`, role `all`) starts the worker pool when background work is registered. `plumbus worker` runs a dedicated pool; role `api` leaves workers to a separate process. The runtime selects the configured shared backend outside deliberate development/memory mode. The settings below are programmatic `WorkerPoolConfig` options; application files expose `workers.enableScheduler` and `workers.eventDelivery`, while the other pool settings are supplied to `createWorkerPool()` or the documented worker environment variables.

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
  onCapabilityError?: (info: CapabilityErrorInfo) => void | Promise<void>;
  onEventDeadLetter?: (info: EventDeadLetterInfo) => void | Promise<void>;
  eventDelivery?: EventDeliveryOptions;
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

Additional hooks (`onQueuesClose`, `redisClient`, `flowsPrefix`, `refreshQueueDepths`, `onFlowStepEnqueue`) are available for durable split deployments — see `packages/plumbus-core/src/worker/bootstrap.ts`. Per-unit data-plane resolution (`dataPlaneResolver`, `listTenantRefs`, `untenantedDataPlane`, `unitDataPlane`, `resolveTenantRef`) is documented in [Tenant Data Planes](tenant-data-planes.md); `plumbus start` / `dev` / `worker` take those from `app/server.ts` exports, and a host that supplies a resolver must not also supply `createDataService`.

The pool auto-registers a `plumbus:flow-trigger` consumer that maps incoming events to flow starts via `createFlowTriggerHandler`.

### Flow lease tuning

The flow runner uses lease-based row claiming (`FOR UPDATE SKIP LOCKED`) so multiple workers sharing the same database never execute the same step twice. The defaults are suitable for most deployments; tune these only when you have a specific reason to.

- **`flowLeaseDurationMs`** (default `300_000` = 5 min) — Upper bound on how long a worker can hold a claim without heartbeating. If a worker crashes, another worker can reclaim the row after this window elapses. Raise it if you run steps longer than the heartbeat interval can reliably cover (e.g. suspended VMs, long GC pauses); lower it to reduce crash-recovery latency.
- **`flowHeartbeatIntervalMs`** (default `flowLeaseDurationMs / 3`) — How often a running worker automatically extends its lease. The 3× safety margin tolerates two missed ticks before the lease is considered expired.
- **`flowClaimBatchSize`** (default `50`) — Max executions a single `claimNext()` poll cycle will lock. Larger batches amortize the poll cost; smaller batches spread work more evenly across workers.
- **Worker identity** — Each worker auto-generates a unique `workerId` of the form `<hostname>:<pid>:<short-uuid>` via `generateWorkerId()`. The pool does not expose a `workerId` knob on `WorkerPoolConfig`; if you need stable identity for observability, pass a `workerId` directly when constructing the engine with `createFlowEngine()`.



## Core 0.8 configuration resolution

`loadConfig({ queue: { prefix: 'app' } })` applies validated nested overrides. `loadAppConfig()` also imports `config/app.config.ts`/`.js`/`.mjs` (named `config` or default), as used by CLI API/worker/operational startup. Precedence: defaults < file < environment < explicit options; CLI-forced environment wins. Unknown keys are errors.

Queue tuning: `pollIntervalMs`, `visibilityTimeoutSec`, `reclaimIntervalMs`, `startupTimeoutMs`, `operationTimeoutMs`, `shutdownTimeoutMs`, `url`, `backend`, `prefix`. `QUEUE_PREFIX` works across all three queues. `workers.enableScheduler` (or `PLUMBUS_ENABLE_SCHEDULER=false`) controls scheduler startup. `workers.eventDelivery` contains `retry`, `unrouted: 'deadLetter' | 'acknowledge'`, and `ignoredEventTypes`. `retry.maxAttempts` counts total calls. `onEventDeadLetter` is an `app/server.ts` worker extension hook.

See [stabilization](../upgrading-stabilization.md) for defaults, legacy retry aliases, migrations, and durable dispatch/replay guarantees.

The CLI wires Redis into API readiness automatically. Custom `createServer` bootstrap can supply `checkQueueReadiness: queues.pingRedis`. Within Redis connection settings, a URL takes precedence over separate host/port credentials. TypeScript config compilation loads lazily when an actual config file is read.
