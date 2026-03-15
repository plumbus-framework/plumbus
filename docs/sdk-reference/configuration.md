# Configuration Reference

Plumbus applications are configured through a typed `PlumbusConfig` object, loaded from environment variables and validated at startup.

## PlumbusConfig

```typescript
interface PlumbusConfig {
  environment: "development" | "staging" | "production";
  database: DatabaseConfig;
  queue: QueueConfig;
  ai?: AIProviderConfig;               // Single provider (legacy)
  aiProviders?: AIProvidersConfig;      // Multi-provider (takes precedence)
  auth: AuthAdapterConfig;
  complianceProfiles?: string[];
}
```

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
DB_HOST=localhost
DB_PORT=5432
DB_NAME=myapp
DB_USER=postgres
DB_PASSWORD=secret
DB_SSL=false
DB_POOL_SIZE=10
```

## Queue Configuration

```typescript
interface QueueConfig {
  host: string;
  port: number;
  password?: string;
  prefix?: string;
}
```

Environment variables:

```bash
QUEUE_HOST=localhost
QUEUE_PORT=6379
QUEUE_PASSWORD=
QUEUE_PREFIX=plumbus
```

## AI Provider Configuration

### Single Provider (Legacy)

```typescript
interface AIProviderConfig {
  provider: string;        // "openai" | "anthropic"
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokensPerRequest?: number;
  dailyCostLimit?: number;
}
```

Environment variables:

```bash
AI_PROVIDER=openai
AI_API_KEY=sk-...
AI_MODEL=gpt-4o-mini
AI_BASE_URL=
AI_MAX_TOKENS=4096
AI_DAILY_COST_LIMIT=50
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

# Anthropic
AI_ANTHROPIC_API_KEY=ant-...
AI_ANTHROPIC_MODEL=claude-sonnet-4-20250514
AI_ANTHROPIC_BASE_URL=           # optional — custom endpoint

# Ollama (OpenAI-compatible)
AI_OLLAMA_API_KEY=
AI_OLLAMA_MODEL=llama3
AI_OLLAMA_BASE_URL=http://localhost:11434/v1
```

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
import { loadConfig, validateConfig } from "plumbus-core";

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
  complianceProfiles: ["SOC2", "GDPR"],
};
```

## Server Configuration

The `createServer()` function accepts a `ServerConfig`:

```typescript
interface ServerConfig {
  port?: number;           // Default: 3000
  host?: string;           // Default: "0.0.0.0"
  capabilities: CapabilityContract[];
  entities: EntityDefinition[];
  events?: EventDefinition[];
  flows?: FlowDefinition[];
  prompts?: PromptDefinition[];
  config: PlumbusConfig;
}
```

> **Production requirement:** `auth.secret` must be set when `environment` is `"production"`. The server will throw on startup if no secret is configured in production. In development/staging, a fallback secret is used with a warning.

The server wires capability routes automatically. Event consumers, flow triggers, and entity repositories are the caller's responsibility to wire into the application lifecycle.

```typescript
import { createServer } from "plumbus-core";

const server = await createServer({
  port: 3000,
  capabilities: [getUser, createUser, updateUser],
  entities: [User, Order],
  events: [userCreated, orderPlaced],
  flows: [onboardingFlow],
  prompts: [classifyTicket],
  config: loadConfig(),
});

await server.start();
```

## Worker Pool Configuration

```typescript
interface WorkerPoolConfig {
  concurrency?: number;    // Default: 5
  pollInterval?: number;   // ms, Default: 1000
  config: PlumbusConfig;
  events?: EventDefinition[];
  flows?: FlowDefinition[];
}
```

```typescript
import { createWorkerPool } from "plumbus-core";

const pool = await createWorkerPool({
  concurrency: 10,
  pollInterval: 500,
  config: loadConfig(),
  events: [userCreated, orderPlaced],
  flows: [onboardingFlow],
});

await pool.start();
```

