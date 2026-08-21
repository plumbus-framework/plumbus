# Define Functions Reference

The `define*` functions are the primary SDK surface for declaring Plumbus resources. Each returns an immutable definition object used by the framework at boot time.

## defineCapability

Creates a capability definition — the atomic unit of business logic.

```typescript
import { defineCapability } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

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
    capabilities: ["billing.getInvoice"], // canonical invoke targets for ctx.capabilities.invoke
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
  riskTier: "read-only",
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
| `access` | `AccessPolicy` | No | Authorization rules (deny-by-default when omitted) |
| `effects` | `EffectsDeclaration` | Yes | Side effect declarations |
| `exposeAs` | `readonly ('mcp' \| 'api')[]` | No | Surfaces to expose (`mcp`, partner `api`) — see [MCP](../mcp/overview.md) and [API](../api/overview.md) |
| `mcp` | `McpExposureConfig` | No | MCP tool metadata when `exposeAs` includes `mcp` |
| `api` | `ApiExposureConfig` | No | Partner API metadata when `exposeAs` includes `api` |
| `audit` | `AuditConfig` | No | Audit trail configuration |
| `explanation` | `ExplanationConfig` | No | Explainability settings |
| `trigger` | `EventHandlerTrigger` | No | **Only `kind: "eventHandler"`** — `{ event: string, versionConstraint?: string }` for auto-registration at worker startup (0.5+) |
| `transactional` | `boolean` | No | When `false`, opts this capability out of the transactional outbox (default: `true` for `action` / `eventHandler`, auto-excluded for `job`, `effects.ai: true`, and non-empty `effects.external`) |
| `riskTier` | `"read-only" \| "limited-reversible" \| "consequential"` | No | F-09 action-risk tier. Only `consequential` requires a bound, unexpired approval before the handler runs. Omitted: no gate. See [approvals](../core-concepts/approvals.md). |
| `handler` | `(ctx, input) => Promise<output>` | Yes | Business logic implementation |

`trigger` on non-`eventHandler` kinds throws at define time. Omit `trigger` to keep manual `ConsumerRegistry` wiring only.

### EffectsDeclaration

| Field | Type | Description |
|-------|------|-------------|
| `data` | `string[]` | Entity names read or written |
| `events` | `string[]` | Event types that may be emitted |
| `external` | `string[]` | External integrations called |
| `capabilities` | `string[]` | Canonical names (`<domain>.<name>`) this handler may invoke via `ctx.capabilities.invoke` |
| `flows` | `string[]` | Flow names this capability may start (optional) |
| `ai` | `boolean` | Whether AI operations are used |

Undeclared `ctx.capabilities.invoke` targets fail at runtime with `dependencyViolation`. Job capabilities cannot appear in `capabilities` — use job dispatch, flows, or events. `plumbus verify` flags missing targets, cycles, non-canonical names, and job invoke declarations.

### Returns

`CapabilityContract<TInput, TOutput>` — an immutable contract object.

---

## defineEntity

Declares a data model with typed, classified fields.

```typescript
import { defineEntity, field } from "@plumbus/core";

const Order = defineEntity({
  name: "Order",
  description: "Customer order",
  domain: "billing",
  tags: ["billing", "core"],
  owner: "team-billing",
  tenantScoped: true,
  fields: {
    id: field.id(),
    customerId: field.relation({ entity: "Customer", type: "many-to-one" }),
    total: field.number({ classification: "internal" }),
    status: field.enum(["pending", "paid", "shipped", "cancelled"]),
    notes: field.string({ nullable: true, classification: "personal" }),
    createdAt: field.timestamp({ default: "now" }),
  },
  indexes: [["customerId"], ["status", "createdAt"]],
  retention: { duration: "365d" },
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
import { defineEvent } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

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
import { defineFlow } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

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
  trigger: { event: "customer.created" },
  steps: [
    { name: "sendWelcomeEmail", type: "capability", capability: "users.sendWelcomeEmail" },
    { name: "setupDefaults", type: "capability", capability: "users.setupCustomerDefaults" },
    {
      name: "checkTier",
      type: "conditional",
      if: "ctx.state.tier === 'enterprise'",
      then: "assignAccountManager",
      else: "sendSelfServeGuide",
    },
    { name: "assignAccountManager", type: "capability", capability: "users.assignAccountManager" },
    { name: "sendSelfServeGuide", type: "capability", capability: "users.sendSelfServeGuide" },
  ],
  retry: { attempts: 3, backoff: "exponential" },
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
| `version` | `string` | No | Authoring version used by `compileFlowDefinition` (default `"1"`) |

### FlowSchedule

```typescript
interface FlowSchedule {
  cron: string; // 5-field cron or interval: "every:60m" | "every:24h" | "every:1d"
  catchUpPolicy?: "skip" | "run-once" | "catch-up"; // default skip — no unbounded backlog
}
```

Use **`schedule`** instead of **`trigger`** when the flow should run on a timer. The scheduler passes `{}` as flow input, so use `input: z.object({})` (or optional fields only). Full walkthrough: [Flows → Scheduled flow example](../core-concepts/flows.md#scheduled-flow-example).

```typescript
const nightlyCleanup = defineFlow({
  name: "nightlyCleanup",
  domain: "maintenance",
  input: z.object({}),
  schedule: { cron: "0 0 * * *" },
  steps: [
    { name: "purgeExpired", type: "capability", capability: "maintenance.purgeExpired" },
  ],
});
```

### Flow Step Types

```typescript
// Capability step
{ name: string; type: "capability"; capability: string; input?: Record<string, unknown> }

// Conditional step
{ name: string; type: "conditional"; if: string; then: string; else?: string }

// Parallel step
{ name: string; type: "parallel"; branches: string[] }

// Wait step
{ name: string; type: "wait"; event: string }

// Delay step
{ name: string; type: "delay"; duration: string }

// Event emit step
{ name: string; type: "eventEmit"; event: string }

// Approval-outcome step (D-02-3; Stage 4 ApprovalService)
{ name: string; type: "approval-outcome"; outcomes: { approved?: string; rejected?: string; "changes-requested"?: string } }
```

`eventEmit` steps send a payload composed from the original flow input merged with the current flow state. If the same key exists in both places, the state value overrides the input value.

### Returns

`FlowDefinition<TInput, TState>` — an immutable flow definition.

---

## definePrompt

Declares an AI prompt with typed input/output and model configuration.

```typescript
import { definePrompt } from "@plumbus/core";
import { z } from "@plumbus/core/zod";

const classifySentiment = definePrompt({
  name: "classifySentiment",
  system: "You classify sentiment. Return only the requested structured fields.",
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
    name: "gpt-4o-mini",
    temperature: 0.3,
    maxTokens: 256,
  },
});
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | Yes | Prompt name |
| `system` | `string` | No | Provider system instructions. Supports top-level `{{key}}` substitution |
| `description` | `string` | No | User/data prompt content. Supports top-level `{{key}}` substitution |
| `domain` | `string` | No | Business domain |
| `tags` | `string[]` | No | Searchable tags |
| `owner` | `string` | No | Owning team |
| `input` | `z.ZodTypeAny` | Yes | Zod schema for prompt input |
| `output` | `z.ZodTypeAny` | Yes | Zod schema for expected output |
| `model` | `ModelConfig` | No | AI model configuration (`provider`, `name`, `temperature`, `maxTokens`, optional `reasoningEffort`: `'low' \| 'medium' \| 'high'`) |
| `appendUnsubstitutedInput` | `boolean` | No | Defaults to appending unused input keys as `Input: {...}`. Set `false` when `description` already renders the full user message |
| `disableStrictStructuredOutputs` | `boolean` | No | Opt this prompt out of provider-side structured outputs even when `enableStrictStructuredOutputs` is enabled globally. Use when the output schema can't fit the provider JSON Schema subset |
| `requireStrictStructuredOutputs` | `boolean` | No | Refuse to run unless a provider JSON Schema can be sent. Use for production extraction paths that must not silently fall back to prompt-only JSON instructions |
| `structuredOutputTransport` | `"response_format" \| "tool"` | No | Select the provider transport for structured output. Defaults to `response_format`; use `"tool"` when JSON-schema response content is weak but strict tool-call arguments are reliable |
| `disableTextModeBrevityHint` | `boolean` | No | For single-string-field outputs streaming as plain text, suppress the brevity-hint suffix that tells the model to "respond with ONLY plain text". Set `true` for long-form payloads (chapters, articles) where the hint collapses output |
| `skipStreamValidationFallback` | `boolean` | No | When `streamGenerate` fails JSON validation, do NOT fall back to a non-streaming retry. Throws instead. Use for prompts with huge input tokens where silently re-paying is unacceptable; the caller is expected to implement its own recovery |

### Returns

`PromptDefinition<TInput, TOutput>` — an immutable prompt definition.

---

## defineTranslation

Declares an i18n message catalog registered at server bootstrap and exposed as `ctx.translations`.

```typescript
import { defineTranslation } from "@plumbus/core";

export const commonTranslation = defineTranslation({
  name: "common",
  defaultLocale: "en",
  locales: ["en", "he"],
  messages: {
    en: {
      "errors.notFound": "Not found",
      "actions.save": "Save",
    },
    he: {
      "errors.notFound": "לא נמצא",
      "actions.save": "שמור",
    },
  },
});
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | Yes | Catalog namespace |
| `defaultLocale` | `string` | Yes | Fallback locale (must appear in `locales`) |
| `locales` | `string[]` | Yes | Supported locale codes |
| `messages` | `Record<string, MessageCatalog>` | Yes | Per-locale key → string map (all locales must share the same keys) |

### Returns

`TranslationDefinition` — an immutable translation catalog.

See [Translations](../core-concepts/translations.md) for CLI export/import and `ctx.translations.t()`.

---

## field

Field constructor namespace for entity field definitions.

```typescript
import { field } from "@plumbus/core";

field.id()                                          // Unique identifier
field.string({ classification: "personal" })        // Text field
field.number({ unique: true })                      // Numeric field
field.boolean({ default: true })                    // Boolean with default
field.timestamp({ default: "now" })                 // Date/time
field.json({ nullable: true })                      // Arbitrary JSON
field.decimal()                                     // Decimal / floating-point
field.enum(["a", "b", "c"])                         // Constrained values (positional)
field.relation({ entity: "User", type: "many-to-one" }) // Foreign key
```

Valid `RelationType` values: `'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'`.

### Base Field Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `required` | `boolean` | `true` | Field is required |
| `optional` | `boolean` | `false` | Field may be omitted on create |
| `default` | `unknown` | — | Default value |
| `unique` | `boolean` | `false` | Unique constraint |
| `nullable` | `boolean` | `false` | Allow null |
| `classification` | `FieldClassification` | — | Data sensitivity level |
| `encrypted` | `boolean` | `false` | Encrypt at rest |

### Field Classifications

```
"public" | "internal" | "personal" | "sensitive" | "highly_sensitive"
```

