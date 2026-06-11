# Plumbus Documentation

Welcome to the Plumbus framework documentation. Use the navigation below to find what you need.

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
│   └── diagrams.md
├── upgrading-workers.md       0.5.0 workers/queues migration guide
├── core-concepts/             Deep dives into each primitive
│   ├── capabilities.md
│   ├── entities.md
│   ├── flows.md
│   ├── events.md
│   └── prompts.md
├── sdk-reference/             Complete API documentation
│   ├── define-functions.md
│   ├── execution-context.md
│   ├── data-layer.md
│   └── configuration.md
├── cli/                       All commands and options
│   └── commands.md
├── security/                  Security model, auth, tenant isolation
│   └── security-model.md
├── ai/                        Prompts, RAG, cost tracking, governance
│   └── ai-integration.md
├── testing/                   Test utilities, patterns, examples
│   └── testing-guide.md
├── ui/                        Client generation, hooks, Next.js scaffolding
│   └── ui-generation.md
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
│   └── design/                10 design decisions (ADRs) explaining the framework's shape
├── chat-ui/                   React hooks/components for the chat turn protocol
│   └── README.md
├── mcp/                       Serve capabilities to AI agents over MCP (stdio + HTTP)
│   ├── overview.md
│   ├── agent-authentication.md
│   ├── expose-a-capability.md
│   ├── transports.md
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
| Configure workers and queues | [Architecture → Workers and Queues](architecture/workers-and-queues.md) |
| Migrate to 0.5.0 workers model | [Upgrading Workers](upgrading-workers.md) |
| Learn about capabilities | [Core Concepts → Capabilities](core-concepts/capabilities.md) |
| See all CLI commands | [CLI → Commands](cli/commands.md) |
| Set up AI coding agents | [Agents → Setup](agents/agent-setup.md) |
| Review framework-first and git-safety rules for agents | [Agents → Guardrails](agents/guardrails.md) |
| Generate a React frontend | [UI → Generation](ui/ui-generation.md) |
| Add a chat surface to my app | [Chat → README](chat/README.md) |
| Add registry-backed knowledge sources | [Knowledge Base → README](knowledge-base/README.md) |
| Wire a React chat UI | [Chat UI → README](chat-ui/README.md) |
| Serve capabilities to AI agents over MCP | [MCP → Overview](mcp/overview.md) |
| Wire MCP tool-call metrics (Datadog, Prometheus, etc.) | [MCP → Transports → onMcpToolCall](mcp/transports.md#per-tool-call-observability--onmcptoolcall) |
| Publish a partner-facing API with OpenAPI | [API → README](api/README.md) (start here) · [Overview](api/overview.md) · [packages/api/README.md](../packages/api/README.md) |
| Write tests | [Testing → Guide](testing/testing-guide.md) |
| Understand the security model | [Security → Model](security/security-model.md) |
| Integrate AI into my app | [AI → Integration](ai/ai-integration.md) |

