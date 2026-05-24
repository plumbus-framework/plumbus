# MCP Transports

`@plumbus/mcp` provides two transports. Both use the same `createMcpServer()` handlers and `executeCapability()` pipeline.

## stdio

**Command:** `plumbus mcp serve` (default when `--http` is omitted) or `plumbus mcp serve --stdio`

- Uses the MCP SDK `StdioServerTransport`.
- Typical for Claude Desktop, Cursor, and local agent runners that spawn a child process.
- **Auth:** set `PLUMBUS_MCP_TOKEN` to a key configured in `plumbus.config.ts` → `mcp.agents` (see [agent-authentication.md](./agent-authentication.md)).

Example Claude Desktop config fragment:

```json
{
  "mcpServers": {
    "my-plumbus-app": {
      "command": "plumbus",
      "args": ["mcp", "serve", "--stdio"],
      "env": {
        "PLUMBUS_MCP_TOKEN": "your-agent-token-key"
      }
    }
  }
}
```

Run from the app project root so resource discovery finds `app/capabilities/`.

## Streamable HTTP

**Command:** `plumbus mcp serve --http [--port 3001] [--host 0.0.0.0]`

- MCP endpoint: `POST /mcp` (Streamable HTTP transport).
- **Discovery:** `GET /mcp/discovery` returns manifest + auth hints:

```json
{
  "manifest": { "tools": [ /* ... */ ] },
  "auth": {
    "tokenHeader": "Authorization",
    "tokenScheme": "Bearer"
  }
}
```

- **Auth:** `Authorization: Bearer <token>` where `<token>` is a key in `mcp.agents`.

Remote agents should fetch discovery first, then call tools with Bearer auth.

## Embedding in `plumbus start`

MCP is **not** mounted by default on `plumbus start` / `createServer`. Use `plumbus mcp serve` or call `registerMcpOnFastify(app, config)` from `onRoutesRegistered` when you want MCP on the same Fastify instance as HTTP.

## Per-request execution

Each `tools/call` creates a fresh `ExecutionContext` via `createDependencies(auth)` → `createExecutionContext(deps)`, mirroring HTTP route handlers. MCP v1 never sets `bypassTenantScope: true`.

Client cancellation: the MCP SDK abort signal is assigned to `ctx.signal`.

## Programmatic API

```typescript
import { createMcpServer, startStdioServer, startHttpServer } from '@plumbus/mcp';

const server = createMcpServer({
  registry,
  db,
  authAdapter,
  createDependencies,
});

await startStdioServer({ server });
// or
const { close } = await startHttpServer({ config, port: 3001 });
```

Framework apps should prefer `plumbus mcp serve`; the package API is for advanced embedding.
