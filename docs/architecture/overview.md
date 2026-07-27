# Architecture Overview

## System Design

Plumbus is a **layered, contract-driven application framework**. Application behavior is expressed through declarative primitives that the framework compiles into a running system.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Layer                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ React App│  │ Next.js  │  │ MCP Agent│  │ External API │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘   │
│       └──────────────┼─────────────┼───────────────┘           │
└──────────────────────┼─────────────┼───────────────────────────┘
                       │ HTTP / MCP  │
┌──────────────────────▼─────────────▼───────────────────────────┐
│                     API Gateway (Fastify)                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Route Generator (auto-generated)            │   │
│  │  GET  /api/{domain}/{name}  →  query capabilities       │   │
│  │  POST /api/{domain}/{name}  →  action capabilities      │   │
│  │  POST /api/{domain}/{name}  →  job capabilities (202)   │   │
│  └─────────────────────────────────────────────────────────┘   │
└──────────────────────┬─────────────────────────────────────────┘
                       │
┌──────────────────────▼─────────────────────────────────────────┐
│                   Execution Engine                              │
│                                                                 │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Input   │  │  Access   │  │ Handler  │  │   Output     │  │
│  │Validation│──▶ Control  │──▶ Execution│──▶  Validation  │  │
│  └──────────┘  └───────────┘  └──────────┘  └──────────────┘  │
│       │                            │                            │
│       │                     ┌──────▼──────┐                    │
│       │                     │  Execution  │                    │
│       │                     │   Context   │                    │
│       │                     └──────┬──────┘                    │
│       │              ┌─────────┬───┴───┬─────────┐            │
│       │              │         │       │         │            │
│  ┌────▼────┐   ┌─────▼──┐ ┌───▼──┐ ┌──▼───┐ ┌──▼────┐      │
│  │  Auth   │   │  Data  │ │Events│ │  AI  │ │Audit  │      │
│  │ Context │   │  Layer │ │Outbox│ │ Svc  │ │  Svc  │      │
│  └─────────┘   └────┬───┘ └──┬───┘ └──┬───┘ └───────┘      │
└─────────────────────┼────────┼────────┼──────────────────────┘
                      │        │        │
┌─────────────────────▼────────▼────────▼──────────────────────┐
│                    Infrastructure                             │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌────────────┐  │
│  │PostgreSQL│  │   Redis   │  │  OpenAI  │  │ Anthropic  │  │
│  │(Drizzle) │  │  (Queue)  │  │(Provider)│  │ (Provider) │  │
│  └──────────┘  └───────────┘  └──────────┘  └────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Package Architecture

```
┌─────────────────────────────────────────────────────┐
│                    @plumbus/ui                       │
│  Client generators, React hooks, Next.js scaffolds  │
│         ┌──────────────────────────────┐            │
│         │      @plumbus/core            │            │
│         │  (workspace dependency)      │            │
│         └──────────┬───────────────────┘            │
└────────────────────┼────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│                   @plumbus/mcp                      │
│  MCP server, stdio/HTTP transports, agent auth        │
│         ┌──────────────────────────────┐            │
│         │      @plumbus/core            │            │
│         └──────────────────────────────┘            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                   @plumbus/chat                     │
│  defineChat, runChatTurn, policy guards, context     │
│  sources, session entities                          │
│         ┌──────────────────────────────┐            │
│         │      @plumbus/core            │            │
│         └──────────────────────────────┘            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                   @plumbus/chat-ui                  │
│  React hooks, <ChatPanel />, SSE client, applyEvent │
│         ┌──────────────────────────────┐            │
│         │      @plumbus/chat            │            │
│         └──────────────────────────────┘            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                   @plumbus/api                      │
│  Partner API contracts, OpenAPI export, manifest    │
│         ┌──────────────────────────────┐            │
│         │      @plumbus/core            │            │
│         └──────────────────────────────┘            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                   @plumbus/voice                    │
│  Realtime speech I/O (+ optional @plumbus/voice-*   │
│  provider packages: livekit, soniox, deepdub, …)    │
│         ┌──────────────────────────────┐            │
│         │      @plumbus/core            │            │
│         └──────────────────────────────┘            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              @plumbus/knowledge-base                │
│  Scoped knowledge providers for chat / RAG          │
│         ┌──────────────────────────────┐            │
│         │      @plumbus/core            │            │
│         └──────────────┬─────────────────┘            │
│                        │ (optional peer of @plumbus/chat)│
└────────────────────────┼────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────┐
│              @plumbus/browser-extension             │
│  Dev-time WXT extension scaffolder                    │
│         ┌──────────────────────────────┐            │
│         │  @plumbus/core + @plumbus/ui  │            │
│         └──────────────────────────────┘            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                   @plumbus/core                       │
│                                                      │
│  ┌────────┐ ┌──────┐ ┌────────┐ ┌───────┐ ┌──────┐ │
│  │ Types  │ │Define│ │Execution│ │ Events│ │Flows │ │
│  └────────┘ └──────┘ └────────┘ └───────┘ └──────┘ │
│  ┌────────┐ ┌──────┐ ┌────────┐ ┌───────┐ ┌──────┐ │
│  │  Data  │ │  AI  │ │  Auth  │ │ Audit │ │  API  │ │
│  └────────┘ └──────┘ └────────┘ └───────┘ └──────┘ │
│  ┌────────┐ ┌──────┐ ┌────────┐ ┌───────┐ ┌──────┐ │
│  │Runtime │ │ Jobs │ │Translat│ │  MCP  │ │Config │ │
│  └────────┘ └──────┘ └────────┘ └───────┘ └──────┘ │
│  ┌────────┐ ┌──────┐ ┌────────┐ ┌───────┐ ┌──────┐ │
│  │Governce│ │Server│ │ Worker │ │Observ.│ │ CLI  │ │
│  └────────┘ └──────┘ └────────┘ └───────┘ └──────┘ │
└──────────────────────────────────────────────────────┘
```

## Module Dependency Graph

```
types/  ◄──────── define/ ──── translations/
  │                  │
  ▼                  ▼
fields/ ◄──── execution/
  │              │    │
  │              ▼    ▼
  │          auth/  errors/
  │              │
  ▼              ▼
data/       audit/
  │              │
  ▼              ▼
events/ ────► flows/     schema/
  │              │
  ▼              ▼
runtime/ ◄── governance/
  │    │           │
  │    ▼           ▼
  │  jobs/       api/
  │    │           │
  ▼    ▼           ▼
ai/ ─────────► server/
  │              │
  ▼              ▼
observability/  cli/ ──► mcp/
                 │
                 ▼
             worker/
```

## Runtime Topology

Plumbus supports three deployment patterns for background work. See [Workers and Queues](./workers-and-queues.md) for the full reference.

| Mode | Command | Queues |
|------|---------|--------|
| In-memory colocated | `plumbus dev` | In-memory, API + workers in one process |
| Redis colocated | `plumbus start` + Redis | Durable, API + workers in one process |
| Split API + worker | `PLUMBUS_RUNTIME_ROLE=api` + `plumbus worker` | Shared Redis, independent scaling |

Background subsystems — outbox dispatch, event consumers, flow steps, scheduled flows, and job capabilities — run in the **worker pool**. The pool starts automatically when the app defines events, flows with triggers, `eventHandler` capabilities, or `job` capabilities.

## Key Design Principles

### 1. Contract-Driven Development

Every piece of application behavior starts with a **declarative contract**:

```
Contract (defineCapability)
    ↓
Framework interprets contract
    ↓
Auto-generates: routes, validation, access checks, audit, docs
    ↓
Developer implements: handler business logic only
```

### 2. Deny-by-Default Security

```
Incoming Request
    │
    ▼
┌─────────────────────────┐
│  Has access policy?     │──── No ───▶ 403 Forbidden
└───────────┬─────────────┘
            │ Yes
            ▼
┌─────────────────────────┐
│  Caller matches roles?  │──── No ───▶ 403 Forbidden
└───────────┬─────────────┘
            │ Yes
            ▼
┌─────────────────────────┐
│  Caller has scopes?     │──── No ───▶ 403 Forbidden
└───────────┬─────────────┘
            │ Yes
            ▼
┌─────────────────────────┐
│  Tenant isolation?      │──── Fail ─▶ 403 Forbidden
└───────────┬─────────────┘
            │ Pass
            ▼
        Handler Executes
```

### 3. Event-Driven Architecture

```
Capability Handler (action / eventHandler — transactional outbox ON by default)
    │
    ├──▶ ctx.data.Entity.create(data)     ← Same DB transaction
    │
    ├──▶ ctx.events.emit("event", data)   ← Inserts event_outbox row
    │                                        (same transaction; rolls back together)
    │
    └──▶ return result
              │
              │  Auto-excluded: kind job, effects.ai, effects.external, query
              │  Opt out: execution.transactionalOutbox: false or transactional: false
              │
              ▼
    ┌─────────────────────┐
    │  Outbox Dispatcher  │ ← Polls event_outbox (~1s default)
    └─────────┬───────────┘
              │
    ┌─────────▼───────────┐
    │    Event Queue      │ ← Redis or in-memory
    └─────────┬───────────┘
              │
    ┌─────────▼───────────┐
    │   Event Consumer    │
    │                     │
    │  ├─ eventHandler    │ ← Capability kind: eventHandler
    │  ├─ Flow trigger    │ ← Starts a flow execution
    │  └─ External        │ ← Webhook, notification, etc.
    └─────────────────────┘
```

### 4. Advisory Governance

Governance in Plumbus is **advisory, not blocking**:

```
plumbus verify
    │
    ▼
┌──────────────────────────────────┐
│       Governance Rule Engine     │
│                                  │
│  ┌──────────┐  ┌─────────────┐  │
│  │ Security │  │  Privacy    │  │
│  │  Rules   │  │   Rules     │  │
│  └──────────┘  └─────────────┘  │
│  ┌──────────┐  ┌─────────────┐  │
│  │ Archit.  │  │    AI       │  │
│  │  Rules   │  │   Rules     │  │
│  └──────────┘  └─────────────┘  │
└────────────┬─────────────────────┘
             │
             ▼
    ⚠️ Warnings (not errors)
    │
    ├─ "Capability 'deleteUser' has overly permissive roles"
    ├─ "Entity 'Payment' stores sensitive data without encryption flag"
    └─ "Flow 'orderProcess' has excessive steps (15)"
```

## Technology Choices

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Language** | TypeScript 5.x (strict, ESM) | Type safety, developer experience |
| **HTTP** | Fastify 5 | Performance, plugin ecosystem |
| **Database** | PostgreSQL + Drizzle ORM | Reliability, type-safe queries |
| **Validation** | Zod | Runtime + static type inference |
| **Events** | Redis queues (or in-memory) | Reliable async processing |
| **CLI** | Commander.js | Standard Node.js CLI toolkit |
| **Testing** | Vitest | Fast, ESM-native, compatible API |
| **Build** | Turborepo + pnpm | Monorepo caching and orchestration |
| **AI** | OpenAI / Anthropic (pluggable) | Provider abstraction layer |

