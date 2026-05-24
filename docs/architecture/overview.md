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
│  │ Access   │  │  Input    │  │ Handler  │  │   Output     │  │
│  │ Control  │──▶ Validation│──▶ Execution│──▶  Validation  │  │
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
│                   @plumbus/core                       │
│                                                      │
│  ┌────────┐ ┌──────┐ ┌────────┐ ┌───────┐ ┌──────┐ │
│  │ Types  │ │Define│ │Execution│ │ Events│ │Flows │ │
│  └────────┘ └──────┘ └────────┘ └───────┘ └──────┘ │
│  ┌────────┐ ┌──────┐ ┌────────┐ ┌───────┐ ┌──────┐ │
│  │  Data  │ │  AI  │ │  Auth  │ │ Audit │ │ CLI  │ │
│  └────────┘ └──────┘ └────────┘ └───────┘ └──────┘ │
│  ┌────────┐ ┌──────┐ ┌────────┐ ┌───────┐ ┌──────┐ │
│  │Governce│ │Server│ │ Worker │ │Observ.│ │Testing│ │
│  └────────┘ └──────┘ └────────┘ └───────┘ └──────┘ │
└──────────────────────────────────────────────────────┘
```

## Module Dependency Graph

```
types/  ◄──────── define/
  │                  │
  ▼                  ▼
fields/ ◄──── execution/
  │              │    │
  │              ▼    ▼
  │          auth/  errors/
  │              │
  ▼              ▼
data/       audit/
  │
  ▼
events/ ────► flows/
  │              │
  ▼              ▼
  │         governance/
  │              │
  ▼              ▼
ai/ ────────► server/
  │              │
  ▼              ▼
observability/  cli/
                 │
                 ▼
             worker/
```

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
Capability Handler
    │
    ├──▶ ctx.data.Entity.create(data)     ← Same transaction
    │
    ├──▶ ctx.events.emit("event", data)   ← Outbox pattern
    │                                        (same transaction)
    │
    └──▶ return result
              │
              ▼
         Transaction commits
              │
              ▼
    ┌─────────────────────┐
    │  Outbox Dispatcher  │ ← Polls outbox table
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

