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
| `ctx.security` | Security service — policy evaluation and access enforcement |

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

### Flat layout (default)

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

### Monorepo layout (`plumbus create --monorepo`)

```
backend/              # Plumbus app — same structure as flat layout above
  app/
  config/
  package.json
frontend/             # Populated by `plumbus ui nextjs`
  src/
  package.json
libs/shared/          # Shared type definitions (auto-generated)
  types/
  package.json
pnpm-workspace.yaml   # pnpm workspaces root
package.json          # Private root — delegates scripts via pnpm -r
```

In monorepo mode the `app/` and `config/` directories live under `backend/`. The CLI auto-detects the layout.

## Framework-Provided Dependencies

The framework provides common dependencies — **consumer apps must NOT install them separately**. Import through the framework's subpath exports:

| Dependency | Import from | Usage |
|-----------|-------------|-------|
| **Zod** | `@plumbus/core/zod` | `import { z } from "@plumbus/core/zod"` |
| **Vitest** | `@plumbus/core/testing` | `import { describe, it, expect } from "@plumbus/core/testing"` |
| **Playwright** | `@plumbus/core/testing` | `import { chromium } from "@plumbus/core/testing"` |
| **Vitest Config** | `@plumbus/core/vitest` | `import { defineConfig } from "@plumbus/core/vitest"` |

**CRITICAL**: Never add `zod`, `vitest`, `playwright`, or `@playwright/test` to a consumer app's `package.json`. They are provided by `@plumbus/core`.

### CLI Commands

| Task | Command |
|------|---------|
| Run tests | `plumbus test` |
| Watch mode | `plumbus test --watch` |
| Run e2e tests | `plumbus test --config frontend/e2e/vitest.config.e2e.ts` |
| Dev server | `plumbus dev` |

## Server Extensions (`app/server.ts`)

The optional `app/server.ts` file exports hooks that customize server behavior. The framework auto-discovers this file on `plumbus dev` and `plumbus start`.

### Available Hooks

| Hook | When it fires | Use for |
|------|--------------|---------|
| `onRoutesRegistered` | After capability routes are registered | Adding custom routes (e.g. streaming endpoints) |
| `onCapabilityError` | After a capability returns a non-success result | Logging capability failures to a system log table |
| `onFlowError` | After a flow fails permanently (retries exhausted) | Logging flow failures to a system log table |
| `onProcessError` | On uncaught exceptions, unhandled rejections, and Fastify-level errors | Logging process-level crashes that bypass capability/flow hooks |
| `resolveAiOverrides` | Before each AI call | Dynamic model/provider configuration from DB |

### Error Capture Coverage

The framework provides hooks for **every error category**:

| Error Type | Hook | Source Field |
|------------|------|-------------|
| Capability failure (handler throw, validation, access) | `onCapabilityError` | capability name, domain, error code |
| Flow permanent failure (retries exhausted) | `onFlowError` | flow name, step, execution ID |
| Uncaught exception (process crash) | `onProcessError` | `source: 'uncaughtException'` |
| Unhandled promise rejection | `onProcessError` | `source: 'unhandledRejection'` |
| Fastify request error (malformed request, timeout) | `onProcessError` | `source: 'fastify'` |

### Example: Full Error Logging

```ts
import type { ServerConfig } from '@plumbus/core';

// Capability errors
export const onCapabilityError: NonNullable<ServerConfig['onCapabilityError']> = async (info) => {
  await db.insert({ level: 'error', message: `[${info.capabilityName}] ${info.errorMessage}`, source: 'backend' });
};

// Flow errors
export const onFlowError = async (info) => {
  await db.insert({ level: 'error', message: `[flow:${info.flowName}] ${info.error}`, source: 'flow-engine' });
};

// Process-level errors (uncaught exceptions, unhandled rejections, Fastify errors)
export const onProcessError: NonNullable<ServerConfig['onProcessError']> = async (info) => {
  await db.insert({ level: 'error', message: `[${info.source}] ${info.message}`, stack: info.stack, source: 'backend' });
};
```

All hooks are fire-and-forget — exceptions inside hooks are caught and swallowed to prevent logging from breaking the application.
