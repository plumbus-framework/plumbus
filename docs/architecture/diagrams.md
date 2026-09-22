# Diagrams

Visual reference for the Plumbus framework architecture and data flows.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                    PLUMBUS FRAMEWORK                        │
│                                                             │
│   ┌───────────────────────────────────────────────────┐    │
│   │                  Developer SDK                     │    │
│   │                                                    │    │
│   │  defineEntity()  defineCapability()  defineFlow()  │    │
│   │  defineEvent()   definePrompt()  defineTranslation() │    │
│   │                                                    │    │
│   └───────────────────────┬───────────────────────────┘    │
│                           │                                 │
│   ┌───────────────────────▼───────────────────────────┐    │
│   │                 Runtime Engine                      │    │
│   │                                                    │    │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │    │
│   │  │ Execution│ │  Event   │ │  Flow Engine     │  │    │
│   │  │  Engine  │ │  System  │ │  (Orchestration) │  │    │
│   │  └──────────┘ └──────────┘ └──────────────────┘  │    │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │    │
│   │  │   AI     │ │ Security │ │   Governance     │  │    │
│   │  │ Runtime  │ │  Layer   │ │   (Advisory)     │  │    │
│   │  └──────────┘ └──────────┘ └──────────────────┘  │    │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │    │
│   │  │  Audit   │ │ Observ.  │ │     Data         │  │    │
│   │  │  Trail   │ │ (Traces) │ │     Layer        │  │    │
│   │  └──────────┘ └──────────┘ └──────────────────┘  │    │
│   └────────────────────────────────────────────────────┘    │
│                                                             │
│   ┌────────────────────────────────────────────────────┐    │
│   │               Infrastructure Layer                  │    │
│   │                                                    │    │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │    │
│   │  │ Fastify  │ │PostgreSQL│ │  Redis / Memory  │  │    │
│   │  │ (HTTP)   │ │(Drizzle) │ │  (Event Queue)   │  │    │
│   │  └──────────┘ └──────────┘ └──────────────────┘  │    │
│   └────────────────────────────────────────────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Six Primitives

```
                        ┌─────────────┐
                        │   Entity    │
                        │ (data model)│
                        └──────┬──────┘
                               │ ctx.data
                               │
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   Event     │◄────────│ Capability   │────────▶│   Prompt    │
│(domain fact)│ emit    │(business op) │ ctx.ai  │ (AI schema) │
└──────┬──────┘         └──────┬───────┘         └─────────────┘
       │                       │ ctx.translations
       │ trigger               │ orchestrate
       │                       │
       │                ┌──────▼──────┐         ┌─────────────┐
       └───────────────▶│    Flow     │         │ Translation │
                        │ (workflow)  │         │  (i18n)     │
                        └─────────────┘         └─────────────┘
```

## Capability Kind Routing

```
┌──────────────────────────────────────────────────────────┐
│                  HTTP Request Arrives                      │
└───────────────────────┬──────────────────────────────────┘
                        │
                ┌───────▼───────┐
                │ Route Matched │
                │ to Capability │
                └───────┬───────┘
                        │
        ┌───────────────┼───────────────┬──────────────────┐
        │               │               │                  │
  ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼──────┐
  │  query    │   │  action   │   │    job    │   │eventHandler │
  │           │   │           │   │           │   │             │
  │ GET       │   │ POST      │   │ POST      │   │ Internal    │
  │ Sync exec │   │ Sync exec │   │ 202 Async │   │ Event-only  │
  │ Read-only │   │ Mutating  │   │ Background│   │ Not routed  │
  └─────┬─────┘   └─────┬─────┘   └─────┬─────┘   └─────┬──────┘
        │               │               │                │
        ▼               ▼               ▼                ▼
    200 + data      200 + data      202 + jobId     (consumed by
                                                     event worker)
```

## Data Flow: Write with Events

```
┌────────────────────────────────────────────────────────────────┐
│                    Handler Execution                            │
│                                                                │
│  ┌──────────────────┐    ┌──────────────────┐                 │
│  │ Data Mutation     │    │ Outbox Insert     │                │
│  │                   │    │                   │                │
│  │ ctx.data.Order    │    │ INSERT INTO       │                │
│  │   .create(data)   │    │ event_outbox      │                │
│  │                   │    │ (event_type,      │                │
│  │ INSERT INTO       │    │  payload,         │                │
│  │ orders (...)      │    │  tenant_id,       │                │
│  │                   │    │  status='pending') │                │
│  └──────────────────┘    └──────────────────┘                 │
│                                                                │
│  Handler + data writes + outbox insert — one transaction (default) │
│  for action/eventHandler; rolls back together on handler failure │
└──────────────────────────────┬─────────────────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  Outbox Dispatcher   │
                    │     picks up         │
                    │                      │
                    │  UPDATE event_outbox │
                    │  SET status =        │
                    │    'dispatched'      │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │    Event Queue       │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   Consumer(s)        │
                    │   execute            │
                    └──────────────────────┘
```

## Governance Analysis

```
plumbus verify
     │
     ▼
┌──────────────────────────────────────────────────┐
│              System Inventory                     │
│                                                  │
│  Collected from all define*() calls:             │
│  • entities[]                                    │
│  • capabilities[]                                │
│  • flows[]                                       │
│  • events[]                                      │
│  • prompts[]                                     │
└───────────────────────┬──────────────────────────┘
                        │
         ┌──────────────┼──────────────┐
         │              │              │
┌────────▼───────┐ ┌────▼────────┐ ┌──▼──────────┐
│  Security      │ │  Privacy    │ │Architecture │
│  Rules (5+)    │ │  Rules (5+) │ │ Rules (5+)  │
│                │ │             │ │             │
│ • Missing      │ │ • PII in   │ │ • Too many  │
│   access policy│ │   logs     │ │   steps     │
│ • Overly broad│ │ • Sensitive │ │ • Excessive │
│   roles       │ │   unencrypt│ │   effects   │
│ • Etc.        │ │ • Etc.     │ │ • Etc.      │
└────────┬───────┘ └────┬────────┘ └──┬──────────┘
         │              │              │
         └──────────────┼──────────────┘
                        │
                 ┌──────▼──────┐
                 │   Report    │
                 │             │
                 │ ⚠ warnings: │
                 │  [{rule,    │
                 │    severity,│
                 │    message, │
                 │    target}] │
                 └─────────────┘
```

## Compliance Profile Assessment

```
                    ┌───────────────────────┐
                    │ plumbus certify       │
                    │   policy gdpr         │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Load Profile Rules   │
                    │                       │
                    │  GDPR Profile:        │
                    │  • Data minimization  │
                    │  • Consent tracking   │
                    │  • Right to deletion  │
                    │  • Data portability   │
                    │  • Breach notification│
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Evaluate against     │
                    │  System Inventory     │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Policy Report        │
                    │                       │
                    │  ✅ 12 rules pass     │
                    │  ⚠️  3 rules warn     │
                    │  ❌  1 rule fail      │
                    │                       │
                    │  Score: 80%           │
                    └───────────────────────┘
```

## UI Code Generation Flow

```
┌─────────────────────┐
│ CapabilityContract[] │
│ (from @plumbus/core) │
└──────────┬──────────┘
           │
           ▼
┌──────────────────────────────────────────────────┐
│                 @plumbus/ui                       │
│                                                  │
│  ┌─────────────────┐  ┌──────────────────────┐  │
│  │ Client Generator │  │  Auth Generator      │  │
│  │                  │  │                      │  │
│  │ → client.ts     │  │ → auth.ts            │  │
│  │ → hooks.ts      │  │ → AuthProvider.tsx    │  │
│  └─────────────────┘  └──────────────────────┘  │
│                                                  │
│  ┌─────────────────┐  ┌──────────────────────┐  │
│  │ Form Generator  │  │  Next.js Generator   │  │
│  │                  │  │                      │  │
│  │ → form-hints.ts │  │ → Full project       │  │
│  │                  │  │   scaffold           │  │
│  └─────────────────┘  └──────────────────────┘  │
└──────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────┐
│              Generated Frontend                   │
│                                                  │
│  generated/                                      │
│  ├── client.ts    (typed fetch functions)        │
│  ├── hooks.ts     (React useState/useEffect)     │
│  ├── auth.ts      (login, logout, token mgmt)    │
│  └── form-hints.ts(field metadata from Zod)      │
│                                                  │
│  components/                                     │
│  └── AuthProvider.tsx                            │
│                                                  │
│  app/                                            │
│  ├── layout.tsx                                  │
│  ├── page.tsx                                    │
│  └── {capability}/page.tsx                       │
└──────────────────────────────────────────────────┘
```

