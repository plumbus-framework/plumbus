# Configuration Reference

Plumbus applications are configured through a typed `PlumbusConfig` object, loaded from environment variables and validated at startup.

## PlumbusConfig

```typescript
interface PlumbusConfig {
  environment: "development" | "staging" | "production";
  database: DatabaseConfig;
  queue: QueueConfig;
  ai?: AIProviderConfig;
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

