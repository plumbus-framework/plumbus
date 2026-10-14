# Plumbus Documentation

Welcome to the Plumbus framework documentation. Use the navigation below to find what you need.

For the current stable core **0.8** family (npm `latest`), start with the [stabilization upgrade guide](./upgrading-stabilization.md): database migrations, coordinated worker cutover, schedule reconciliation, and agent wiring **v21**. The [core changelog](../packages/plumbus-core/CHANGELOG.md) maps each fix to the original PLB issue.

For the core **0.9** beta family (branch and npm dist-tag `plumbus-next`: core 0.9.x, UI 0.10.x, MCP 0.8.x, voice 0.7.x, other add-ons 0.4.x), read the [core 0.9 beta upgrade guide](./upgrading-core-0.9.md): version table, breaking changes, and the beta dist-tag. The beta family includes everything in the 0.8 stabilization family.

For classification provider/model selection and agent wiring v17, see the
[classification upgrade guide](./upgrading-classification.md) and
[packaged agent recipe](../packages/plumbus-core/instructions/ai-classification.md).
Core 0.7.9 introduced wiring v19, which also links the OpenAI Decisions provider
(`@plumbus/ai-decision-openai`); see [Agent setup](./agents/agent-setup.md#openai-decisions-provider--wiring-v19)
and [Decision providers](./ai/decision-providers.md).

The [2026-09-23 voice and decision release guide](./upgrading-voice-and-decision-release.md) records earlier package versions and paired upgrades.

The [Vitest 5 migration guide](./upgrading-vitest.md) covers the bundled test-runner upgrade, Node requirements, worker limits, and existing app test configs.

## Documentation Map

```
docs/
├── getting-started/           Installation, first project, tutorial
│   ├── installation.md
│   ├── quick-start.md
│   ├── development-workflow.md
│   └── tutorial.md
├── architecture/              System design, diagrams, data flow
│   ├── overview.md
│   ├── workers-and-queues.md
│   ├── execution-lifecycle.md
│   ├── dispatch-state-protocol.md  Protocol A (durable dispatch)
│   └── diagrams.md
├── upgrading-core-0.9.md      Core 0.9 beta family: versions, breaking changes, dist-tag
├── upgrading-stabilization.md  Core 0.8 family, migrations, cutover, and wiring v21
├── upgrading-vitest.md        Vitest 5.0.4, Node requirements, worker limits
├── upgrading-workers.md       0.5.0 workers/queues migration guide
├── upgrading-capability-names.md  Canonical names, invoke policy, flow auth snapshot
├── upgrading-voice-provider-packages.md  0.4.0 voice provider add-on packages
├── upgrading-contract-alignment.md  Runtime contract fixes (outbox, AI security, encryption, locale, chat/KB)
│   (0.6.0 AI cost ledger: see ai/ai-integration.md → Upgrading to @plumbus/core 0.6.0)
├── core-concepts/             Deep dives into each primitive
│   ├── capabilities.md
│   ├── approvals.md           Human tasks, approval gate, action-risk tiers
│   ├── entities.md
│   ├── flows.md
│   ├── events.md
│   ├── prompts.md
│   ├── translations.md
│   └── governance.md
├── sdk-reference/             Complete API documentation
│   ├── define-functions.md
│   ├── execution-context.md
│   ├── data-layer.md
│   ├── tenant-data-planes.md  Provision, migrate as owner, resolve as runtime
│   ├── credential-catalog.md  Host-declared credential types, opaque refs
│   ├── configuration.md
│   └── observability.md
├── cli/                       All commands and options
│   └── commands.md
├── security/                  Security model, auth, tenant isolation
│   └── security-model.md
├── payments/                  Optional @plumbus/payments + @plumbus/payments-stripe (sellers charge their clients; the app bills its customers)
│   ├── README.md
│   ├── getting-started.md
│   ├── options.md             Every option and Stripe choice, and what is not offered
│   ├── use-cases.md           Which features to combine for your kind of app
│   ├── billing.md             The app's own plans: catalog, seats, meters, entitlements
│   ├── stripe.md
│   ├── webhooks.md
│   ├── testing.md
│   └── security.md
├── auth/                      Optional @plumbus/auth package (OIDC RP, server sessions, CSRF)
│   ├── README.md
│   ├── getting-started.md
│   ├── configuration.md
│   ├── providers.md
│   ├── sessions-and-csrf.md
│   ├── cognito.md
│   ├── security.md
│   ├── testing.md
│   ├── migration.md
│   └── deployment.md
├── ai/                        Prompts, RAG, cost tracking, governance, Bedrock
│   ├── ai-integration.md      Prompts, RAG, cost tracking, governed model calls
│   ├── bedrock.md             Optional @plumbus/ai-bedrock (detailed guide)
│   ├── decision-providers.md  Typed decisions (TypeSafe/Jev, Laya, OpenAI Decisions), cost recording, live tests
│   └── decision-provider-audit.md  First adversarial audit
├── testing/                   Test utilities, patterns, examples
│   └── testing-guide.md
├── ui/                        Client generation, hooks, Next.js scaffolding
│   └── ui-generation.md
├── browser-extension/         Optional @plumbus/browser-extension scaffolder
│   ├── README.md
│   └── usage.md
├── knowledge-base/            Optional @plumbus/knowledge-base package (scoped providers + registry)
│   ├── README.md
│   ├── defining-sources.md
│   ├── providers.md
│   ├── usage-patterns.md
│   ├── chat-integration.md
│   ├── rag-via-core.md
│   └── testing.md
├── chat/                      Conversational runtime: defineChat, guards, context sources
│   ├── README.md
│   ├── defining-chats.md
│   ├── policies.md
│   ├── context-sources.md
│   ├── testing.md
│   ├── evaluations.md
│   ├── tool-calling.md        Provider-native tool calling (Path B)
│   ├── confirmation-persistence.md  Durable confirmations + session revision CAS
│   ├── session-store.md       Injectable session storage for deployments with no local DB
│   └── design/                11 design decisions (ADRs) explaining the framework's shape
├── chat-ui/                   React hooks/components for the chat turn protocol
│   └── README.md
├── voice/                     Optional @plumbus/voice package (realtime speech I/O runtime)
│   ├── README.md
│   ├── defining-voices.md
│   ├── configuration.md
│   ├── providers.md
│   ├── transports.md
│   ├── client-stt.md
│   ├── local-providers.md
│   ├── cost-tracking.md
│   ├── noise-cancellation.md
│   ├── livekit-continuous-voice.md
│   ├── testing.md
│   ├── security.md
│   └── design/
│       └── providers.md
├── mcp/                       Serve capabilities to AI agents over MCP (stdio + HTTP)
│   ├── overview.md
│   ├── agent-authentication.md
│   ├── expose-a-capability.md
│   ├── transports.md
│   ├── tasks-and-jobs.md
│   └── skill-files.md
├── api/                       Optional @plumbus/api package (partner API contracts, OpenAPI, diff)
│   ├── README.md              Folder index — navigation, reading paths, agent instructions
│   ├── overview.md            Mental model, install, quick start, request lifecycle
│   ├── exposure-model.md      exposeAs, api metadata, auth, idempotency, eligible kinds
│   ├── manifest.md            api.yaml field reference, validation error catalog
│   ├── openapi.md             OpenAPI generation, envelopes, security schemes
│   ├── test-intent.md         Partner sandbox testing, fixtures, containment rules
│   ├── structure-policy.md    Tenant routing, GET semantics, public+test guard
│   ├── compatibility.md       Breaking vs non-breaking diff, CI workflow
│   └── governance.md          Advisory apiRules in plumbus verify
├── agents/                    Wiring AI coding agents to your project
│   ├── agent-setup.md
│   └── guardrails.md
└── assets/                    Diagrams and images
    └── plumbus-banner.svg
```

## Quick Links

| I want to... | Go to |
|--------------|-------|
| Install Plumbus and create my first app | [Getting Started → Installation](getting-started/installation.md) |
| Understand the development workflow | [Getting Started → Development Workflow](getting-started/development-workflow.md) |
| Understand how the system works | [Architecture → Overview](architecture/overview.md) |
| Read the vNext dispatch/state protocol | [Architecture → Dispatch/state protocol](architecture/dispatch-state-protocol.md) |
| Configure workers and queues | [Architecture → Workers and Queues](architecture/workers-and-queues.md) |
| Upgrade to the core 0.9 beta family | [Upgrading to Core 0.9 (beta)](upgrading-core-0.9.md) |
| Upgrade to the core 0.8 stabilization family | [Upgrading for Stabilization](upgrading-stabilization.md) |
| Upgrade app tests to Vitest 5 | [Upgrading Vitest](upgrading-vitest.md) |
| Migrate to 0.5.0 workers model | [Upgrading Workers](upgrading-workers.md) |
| Migrate to canonical capability names | [Upgrading Capability Names](upgrading-capability-names.md) |
| Migrate voice cloud providers to add-on packages (0.4.0) | [Upgrading Voice Provider Packages](upgrading-voice-provider-packages.md) |
| Review runtime contract-alignment changes | [Upgrading for Contract Alignment](upgrading-contract-alignment.md) |
| Migrate AI cost ledgers to 0.6.0 voice/media operations | [AI → Upgrading to 0.6.0](ai/ai-integration.md#upgrading-to-plumbuscore-060) |
| Learn about capabilities | [Core Concepts → Capabilities](core-concepts/capabilities.md) |
| Learn about approvals and risk tiers | [Core Concepts → Approvals](core-concepts/approvals.md) |
| See all CLI commands | [CLI → Commands](cli/commands.md) |
| Set up AI coding agents | [Agents → Setup](agents/agent-setup.md) |
| Review framework-first and git-safety rules for agents | [Agents → Guardrails](agents/guardrails.md) |
| Generate a React frontend | [UI → Generation](ui/ui-generation.md) |
| Scaffold a browser extension | [Browser Extension → README](browser-extension/README.md) |
| Add a chat surface to my app | [Chat → README](chat/README.md) |
| Add registry-backed knowledge sources | [Knowledge Base → README](knowledge-base/README.md) |
| Wire a React chat UI | [Chat UI → README](chat-ui/README.md) |
| Add a realtime voice surface | [Voice → README](voice/README.md) |
| Run continuous LiveKit voice sessions | [Voice → LiveKit continuous voice](voice/livekit-continuous-voice.md) |
| Configure voice noise cancellation | [Voice → Noise Cancellation](voice/noise-cancellation.md) |
| Serve capabilities to AI agents over MCP | [MCP → Overview](mcp/overview.md) |
| Wire MCP tool-call metrics (Datadog, Prometheus, etc.) | [MCP → Transports → onMcpToolCall](mcp/transports.md#per-tool-call-observability--onmcptoolcall) |
| Publish a partner-facing API with OpenAPI | [API → README](api/README.md) (start here) · [Overview](api/overview.md) · [packages/api/README.md](../packages/api/README.md) |
| Write tests | [Testing → Guide](testing/testing-guide.md) |
| Understand the security model | [Security → Model](security/security-model.md) |
| Apply schema to a per-tenant database | [SDK → Tenant data planes](sdk-reference/tenant-data-planes.md) |
| Declare named credential types without logging secrets | [SDK → Credential catalog](sdk-reference/credential-catalog.md) |
| Add federated OIDC login with server sessions | [Auth → README](auth/README.md) |
| Classify with a selected provider/model (Jev, Laya, OpenAI Decisions, or generative) | [Agent recipe](../packages/plumbus-core/instructions/ai-classification.md) |
| Test Jev, self-hosted Laya, or OpenAI Decisions | [AI → Decision providers](ai/decision-providers.md) |
| Integrate AI into my app | [AI → Integration](ai/ai-integration.md) |
| Use Amazon Bedrock (optional AWS SDK package) | [AI → Amazon Bedrock](ai/bedrock.md) (detailed) · [AI Integration § Bedrock](ai/ai-integration.md#amazon-bedrock-plumbusai-bedrock) |
| Use structured logging and metrics | [SDK Reference → Observability](sdk-reference/observability.md) |
