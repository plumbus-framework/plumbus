# Define Functions Reference

The `define*` functions are the primary SDK surface for declaring Plumbus resources. Each returns an immutable definition object used by the framework at boot time.

## defineCapability

Creates a capability definition — the atomic unit of business logic.

```typescript
import { defineCapability } from "plumbus-core";
import { z } from "zod";

const getUser = defineCapability({
  name: "getUser",
  kind: "query",
  domain: "users",
  description: "Fetch a user by ID",
  tags: ["users", "public"],
  version: "1.0.0",
  owner: "team-identity",
  input: z.object({ userId: z.string().uuid() }),
  output: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  access: {
    roles: ["admin", "user"],
    scopes: ["users:read"],
    tenantScoped: true,
  },
  effects: {
    data: ["User"],
    events: [],
    external: [],
    ai: false,
  },
  audit: {
    enabled: true,
    event: "user.read",
    includeInput: ["userId"],
    includeOutput: ["id"],
  },
  explanation: {
    enabled: true,
    summary: "Fetches user profile by ID",
  },
  handler: async (ctx, input) => {
    const user = await ctx.data.User.findById(input.userId);
    if (!user) throw ctx.errors.notFound("User not found");
    return user;
  },
});
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | Yes | Unique capability name |
| `kind` | `"query" \| "action" \| "job" \| "eventHandler"` | Yes | Determines HTTP method and behavior |
| `domain` | `string` | Yes | Business domain grouping |
| `description` | `string` | No | Human-readable description |
| `tags` | `string[]` | No | Searchable tags |
| `version` | `string` | No | Semantic version |
| `owner` | `string` | No | Owning team or person |
| `input` | `z.ZodTypeAny` | Yes | Zod schema for input validation |
| `output` | `z.ZodTypeAny` | Yes | Zod schema for output type |
| `access` | `AccessPolicy` | Yes | Authorization rules |
| `effects` | `EffectsDeclaration` | Yes | Side effect declarations |
| `audit` | `AuditConfig` | No | Audit trail configuration |
| `explanation` | `ExplanationConfig` | No | Explainability settings |
| `handler` | `(ctx, input) => Promise<output>` | Yes | Business logic implementation |

### Returns

`CapabilityContract<TInput, TOutput>` — an immutable contract object.

---

## defineEntity

Declares a data model with typed, classified fields.

```typescript
import { defineEntity, field } from "plumbus-core";

const Order = defineEntity({
  name: "Order",
  description: "Customer order",
  domain: "billing",
  tags: ["billing", "core"],
  owner: "team-billing",
  tenantScoped: true,
  fields: {
    id: field.id(),
    customerId: field.relation({ entity: "Customer", type: "belongsTo" }),
    total: field.number({ classification: "internal" }),
    status: field.enum(["pending", "paid", "shipped", "cancelled"]),
    notes: field.string({ nullable: true, classification: "personal" }),
    createdAt: field.timestamp({ default: "now" }),
  },
  indexes: [["customerId"], ["status", "createdAt"]],
  retention: { strategy: "archive", periodDays: 365 },
});
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | Yes | Entity name (PascalCase) |
| `description` | `string` | No | Human-readable description |
| `domain` | `string` | No | Business domain grouping |
| `tags` | `string[]` | No | Searchable tags |
| `owner` | `string` | No | Owning team |
| `fields` | `Record<string, FieldDescriptor>` | Yes | Field definitions |
| `indexes` | `string[][]` | No | Composite indexes |
| `retention` | `EntityRetention` | No | Data retention policy |
| `tenantScoped` | `boolean` | No | Enable automatic tenant isolation |

### Returns

`EntityDefinition` — an immutable entity definition.

---

## defineEvent

Declares a domain event with a typed payload.

```typescript
import { defineEvent } from "plumbus-core";
import { z } from "zod";

const orderPlaced = defineEvent({
  name: "order.placed",
  description: "Emitted when a new order is placed",
  domain: "billing",
  version: "1.0.0",
  tags: ["billing", "order"],
  payload: z.object({
    orderId: z.string().uuid(),
    customerId: z.string().uuid(),
    total: z.number(),
  }),
});
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | Yes | Event name (`domain.pastTense` convention) |
| `description` | `string` | No | Human-readable description |
| `domain` | `string` | No | Business domain |
| `version` | `string` | No | Event schema version |
| `tags` | `string[]` | No | Searchable tags |
| `payload` | `z.ZodTypeAny` | Yes | Zod schema for event payload |

### Returns

`EventDefinition<TPayload>` — an immutable event definition.

---

## defineFlow

Declares a multi-step workflow with steps, triggers, and retry policies.

```typescript
import { defineFlow } from "plumbus-core";
import { z } from "zod";

const onboarding = defineFlow({
  name: "customerOnboarding",
  domain: "users",
  description: "New customer onboarding flow",
  tags: ["users", "onboarding"],
  input: z.object({ customerId: z.string().uuid() }),
  state: z.object({
    customerId: z.string(),
    emailSent: z.boolean().default(false),
    welcomeKitDispatched: z.boolean().default(false),
  }),
  trigger: { type: "event", event: "customer.created" },
  steps: [
    { name: "sendWelcomeEmail", capability: "sendWelcomeEmail" },
    { name: "setupDefaults", capability: "setupCustomerDefaults" },
    {
      name: "checkTier",
      type: "conditional",
      condition: "ctx.state.tier === 'enterprise'",
      ifTrue: "assignAccountManager",
      ifFalse: "sendSelfServeGuide",
    },
    { name: "assignAccountManager", capability: "assignAccountManager" },
    { name: "sendSelfServeGuide", capability: "sendSelfServeGuide" },
  ],
  retry: { maxAttempts: 3, backoff: "exponential" },
});
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | Yes | Flow name |
| `domain` | `string` | Yes | Business domain |
| `description` | `string` | No | Human-readable description |
| `tags` | `string[]` | No | Searchable tags |
| `input` | `z.ZodTypeAny` | Yes | Zod schema for flow input |
| `state` | `z.ZodTypeAny` | No | Zod schema for flow state |
| `steps` | `FlowStep[]` | Yes | Ordered step definitions |
| `trigger` | `FlowTrigger` | No | What initiates the flow |
| `schedule` | `FlowSchedule` | No | Cron schedule config |
| `retry` | `FlowRetryPolicy` | No | Retry policy |

### Flow Step Types

```typescript
// Capability step
{ name: string; capability: string }

// Conditional step
{ name: string; type: "conditional"; condition: string; ifTrue: string; ifFalse: string }

// Parallel step
{ name: string; type: "parallel"; branches: string[] }

// Wait step
{ name: string; type: "wait"; event: string; timeout?: string }

// Delay step
{ name: string; type: "delay"; duration: string }

// Event emit step
{ name: string; type: "eventEmit"; event: string }
```

### Returns

`FlowDefinition<TInput, TState>` — an immutable flow definition.

---

## definePrompt

Declares an AI prompt with typed input/output and model configuration.

```typescript
import { definePrompt } from "plumbus-core";
import { z } from "zod";

const classifySentiment = definePrompt({
  name: "classifySentiment",
  description: "Classify text sentiment",
  domain: "support",
  tags: ["ai", "nlp"],
  owner: "team-ai",
  input: z.object({ text: z.string() }),
  output: z.object({
    sentiment: z.enum(["positive", "neutral", "negative"]),
    confidence: z.number().min(0).max(1),
  }),
  model: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.3,
    maxTokens: 256,
  },
});
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | Yes | Prompt name |
| `description` | `string` | No | Human-readable description |
| `domain` | `string` | No | Business domain |
| `tags` | `string[]` | No | Searchable tags |
| `owner` | `string` | No | Owning team |
| `input` | `z.ZodTypeAny` | Yes | Zod schema for prompt input |
| `output` | `z.ZodTypeAny` | Yes | Zod schema for expected output |
| `model` | `ModelConfig` | No | AI model configuration |

### Returns

`PromptDefinition<TInput, TOutput>` — an immutable prompt definition.

---

## field

Field constructor namespace for entity field definitions.

```typescript
import { field } from "plumbus-core";

field.id()                                          // Unique identifier
field.string({ classification: "personal" })        // Text field
field.number({ unique: true })                      // Numeric field
field.boolean({ default: true })                    // Boolean with default
field.timestamp({ default: "now" })                 // Date/time
field.json({ nullable: true })                      // Arbitrary JSON
field.enum(["a", "b", "c"])                         // Constrained values
field.relation({ entity: "User", type: "belongsTo" }) // Foreign key
```

### Base Field Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `required` | `boolean` | `true` | Field is required |
| `default` | `unknown` | — | Default value |
| `unique` | `boolean` | `false` | Unique constraint |
| `nullable` | `boolean` | `false` | Allow null |
| `classification` | `FieldClassification` | — | Data sensitivity level |
| `encrypted` | `boolean` | `false` | Encrypt at rest |
| `maskedInLogs` | `boolean` | `false` | Redact in logs |

### Field Classifications

```
"public" | "internal" | "personal" | "sensitive" | "highly_sensitive"
```

