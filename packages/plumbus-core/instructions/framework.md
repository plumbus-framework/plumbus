# Plumbus Framework

Plumbus is an AI-native, contract-driven TypeScript application framework. You build applications by composing five primitives — **Entities**, **Capabilities**, **Flows**, **Events**, and **Prompts** — through a controlled execution context (`ctx`).

## Core Abstractions

| Primitive | Purpose | Defined with |
|-----------|---------|--------------|
| **Entity** | Data model with classification, retention, relations | `defineEntity()` |
| **Capability** | Discrete unit of business logic (query, action, job, event handler) | `defineCapability()` |
| **Flow** | Multi-step workflow orchestrating capabilities | `defineFlow()` |
| **Event** | Domain fact emitted by capabilities, consumed by handlers/flows | `defineEvent()` |
| **Prompt** | AI interaction template with typed input/output | `definePrompt()` |

## Execution Context (`ctx`)

Every capability handler receives `ctx` — the scoped runtime context:

| Property | Purpose |
|----------|---------|
| `ctx.auth` | Authenticated identity — userId, roles, scopes, tenantId |
| `ctx.data` | Entity repositories — `ctx.data.User.findById(id)` |
| `ctx.events` | Event emission — `ctx.events.emit("order.placed", payload)` |
| `ctx.flows` | Flow orchestration — `ctx.flows.start("processRefund", input)` |
| `ctx.ai` | AI operations — generate, extract, classify, retrieve |
| `ctx.audit` | Audit logging — `ctx.audit.record("user.updated", meta)` |
| `ctx.errors` | Structured errors — validation, notFound, forbidden, conflict, internal |
| `ctx.logger` | Structured logging — info, warn, error |
| `ctx.time` | Time utilities — `ctx.time.now()` |
| `ctx.config` | Read-only application configuration |

## How Subsystems Connect

1. **Capabilities** are the only entry points for business logic. HTTP routes are auto-generated from capability contracts.
2. **Entities** provide typed data access via repositories injected on `ctx.data`.
3. **Events** are emitted inside capabilities (`ctx.events.emit`), persisted via the outbox pattern (same transaction as data), then dispatched to consumers.
4. **Flows** orchestrate multiple capabilities in sequence, with support for conditional branching, parallel execution, waits, and delays. Flows can be triggered by events or cron schedules.
5. **Prompts** provide structured AI interactions. Capabilities invoke AI via `ctx.ai.generate({ prompt: "promptName", input })`.
6. **Security** is deny-by-default. Every capability declares an `access` policy. The framework evaluates it against `ctx.auth` before executing the handler.
7. **Audit** records are automatically created for capability executions, data mutations, and AI invocations.
8. **Governance** rules analyze the entire system (entities, capabilities, flows, events, prompts) and produce advisory signals — warnings, not blockers.

## Project Structure

```
app/
  capabilities/<domain>/<name>/
    capability.ts     # Contract (defineCapability)
    impl.ts           # Handler implementation
    tests/            # Tests
  flows/<domain>/<name>/
    flow.ts           # Contract (defineFlow)
    tests/
  entities/
    <name>.entity.ts  # Entity definition
  events/
    <name>.event.ts   # Event definition
  prompts/
    <name>.prompt.ts  # Prompt definition
config/
  app.config.ts       # PlumbusConfig
  ai.config.ts        # AI provider configuration
```
