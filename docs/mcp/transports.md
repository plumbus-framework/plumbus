# MCP Transports

`@plumbus/mcp` provides two transports. Both use the same `createMcpServer()` handlers and `executeCapability()` pipeline.

CLI startup resolves `PLUMBUS_ENV`, then `NODE_ENV`, defaulting to `development`. Outside development, both transports require configured agents or a valid explicit `AUTH_SECRET`; missing credentials and known development placeholder secrets stop startup. Development without credentials is anonymous and never accepts placeholder-signed JWTs. The CLI currently loads environment variables, not project config files; agent maps require application-owned runtime wiring. See [CLI environment and credentials](./agent-authentication.md#cli-environment-and-credentials).

## stdio

**Command:** `plumbus mcp serve` (default when `--http` is omitted) or `plumbus mcp serve --stdio`

- Uses the MCP SDK `StdioServerTransport`.
- Typical for Claude Desktop, Cursor, and local agent runners that spawn a child process.
- **Auth:** with an application-wired agent-map adapter, set `PLUMBUS_MCP_TOKEN` to a configured agent key (see [agent-authentication.md](./agent-authentication.md)). CLI JWT authentication requires the runner to forward an Authorization header in request metadata.

Example Claude Desktop config fragment for an application-owned runner that supplies an agent-map adapter:

```json
{
  "mcpServers": {
    "my-plumbus-app": {
      "command": "node",
      "args": ["dist/mcp-server.js"],
      "env": {
        "PLUMBUS_MCP_TOKEN": "your-agent-token-key"
      }
    }
  }
}
```

Run from the app project root so resource discovery finds `app/capabilities/`.

## Streamable HTTP

Every request to the MCP transport route authenticates before the SDK takes over the connection, including initialization and tool listing. Missing/invalid credentials return 401. The separate discovery document retains its documented public default and `requireDiscoveryAuth` opt-in. An anonymous-only development CLI can use stdio; authenticated HTTP requires credentials.

Tool failures use core's safe error formatter: internal errors use a generic message, forbidden responses do not enumerate policy requirements, and metadata is allowlisted. Detailed errors remain available through server-side error hooks.

**Command:** `plumbus mcp serve --http --port $PLUMBUS_MCP_PORT [--host 0.0.0.0]`

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

- **Auth:** `Authorization: Bearer <token>`: a JWT signed with the CLI's explicit `AUTH_SECRET`, or an opaque agent key when the runtime uses `createMcpAuthAdapter`.

Remote agents should fetch discovery first, then call tools with Bearer auth.

## Embedding in `plumbus start`

MCP is **not** mounted by default on `plumbus start` / `createServer`. Use `plumbus mcp serve` or call `registerMcpOnFastify(app, config)` from `onRoutesRegistered` when you want MCP on the same Fastify instance as HTTP.

## Per-request execution

Each `tools/call` creates a fresh `ExecutionContext` via `createDependencies(auth, { bypassTenantScope })` → `createExecutionContext(deps)`, mirroring HTTP route handlers exactly. The `bypassTenantScope` flag is set per-call from `capability.access?.tenantScoped === false` in the `CallToolRequestSchema` handler — the same rule the HTTP route generator applies. Tenant-scoped capabilities (the default) still enforce tenant isolation.

Client cancellation: the MCP SDK abort signal is assigned to `ctx.signal`. If `config.requestTimeoutMs` is set, a second abort signal is composed in and fires after the timeout.

## Embedding HTTP transport on your own Fastify app

`registerMcpOnFastify(app, config, mcpOptions?)` mounts the Streamable HTTP transport and discovery route on an existing Fastify instance. Useful when you want MCP on the same port as your HTTP API.

```typescript
import { registerMcpOnFastify } from '@plumbus/mcp';

onRoutesRegistered(async (app, routeConfig) => {
  await registerMcpOnFastify(app, {
    registry,
    db: routeConfig.db,
    authAdapter: routeConfig.authAdapter,
    createDependencies: routeConfig.createDependencies,
  }, {
    path: '/mcp',                  // default
    discoveryPath: '/mcp/discovery', // default
    stateless: true,               // default — no session affinity
    requireDiscoveryAuth: false,   // default — discovery is unauthenticated
    // maxRequestBodySize: 1_048_576, // optional — route bodyLimit + SDK transport limit
    // sessionIdleTimeoutMs: 1_800_000, // default 30 min, stateful mode only; 0 disables
  });
});
```

| Option | Default | Notes |
|---|---|---|
| `path` | `'/mcp'` | The Streamable HTTP endpoint. Accepts all HTTP methods (the transport multiplexes). |
| `discoveryPath` | `'/mcp/discovery'` | `GET` returns `{ manifest, auth }`. Agents typically fetch this first. |
| `stateless` | `true` | When `true`, every request is served by a fresh MCP server + transport (the SDK refuses to reuse a stateless transport). Set `false` for sessions: each `initialize` creates its own server + transport under a UUID session id. |
| `requireDiscoveryAuth` | `false` | When `true`, the discovery route requires a valid Bearer token. Turn this on if the tool *list* itself is sensitive (e.g. you don't want third parties enumerating capability descriptions). |
| `maxRequestBodySize` | unset | Bytes. When set, used as the MCP route's Fastify `bodyLimit` (413 above it) and as the SDK transport's `maxRequestBodySize`. When unset, the Fastify instance `bodyLimit` applies (Fastify default 1 MiB). |
| `sessionIdleTimeoutMs` | `1_800_000` (30 min) | Stateful mode only. Closes a session after this long with no request or stream open, so abandoned sessions are released; the client then gets `404 Session not found` and re-initializes. `0` or `Infinity` disables it (sessions live until DELETE or app close). Negative values throw at registration. Before mcp 0.8 the default was off. |

### Sessions (stateful mode)

With `stateless: false`, a session belongs to the user + tenant that sent `initialize`. A request carrying that `mcp-session-id` from any other user or tenant gets `404 Session not found` — it cannot open the session's SSE stream, send on it, or `DELETE` it. `DELETE` (or `app.close()`) closes the session's server and transport. Sessions live in process memory, so multi-instance deployments need session affinity.

Tasks created in a session are visible only from that session — see [Tasks and jobs](./tasks-and-jobs.md#ownership).

### Limits

- **Tool arguments:** `McpServerConfig.maxToolInputElements` (default `100_000`, exported as `DEFAULT_MAX_TOOL_INPUT_ELEMENTS`) caps the combined number of array elements and object members in one `tools/call` `arguments` payload. Larger payloads get JSON-RPC `InvalidParams` before validation or execution. `Infinity` disables the check. Applies to every transport.
- **Request body:** see `maxRequestBodySize` above. Fastify's body limit always applies.

### Per-tool-call observability — `onMcpToolCall`

`McpServerConfig.onMcpToolCall` fires once per `tools/call`, after the underlying `executeCapability` returns (success or error). It fires on both paths:

- The synchronous (inline) `tools/call` path — hook fires immediately before the response.
- The task-augmented path (`kind: 'job'` + `_meta.taskMetadata`) — hook fires in the background `finally`, after the handler resolves and the `mcp_task` row is updated. `durationMs` covers the full handler duration, not the time the original `tools/call` returned.

Errors thrown by the hook are caught and logged to stderr; they never propagate to the MCP client. Use this to wire latency histograms, per-agent counters, etc.

```ts
const config: McpServerConfig = {
  // ... existing fields
  onMcpToolCall: (info) => {
    metrics.histogram('mcp_tool_call_ms', info.durationMs, {
      capability: info.capabilityName,
      domain: info.domain,
      status: info.status,
    });
  },
};
```

Mirrors `onAICostRecorded` semantics — fire-and-forget, same error policy.

`McpToolCallInfo` fields:

| Field | Description |
|-------|-------------|
| `capabilityName` | Tool / capability name |
| `domain` | Capability domain |
| `durationMs` | Wall time for `executeCapability` on this call |
| `status` | `'success'` or `'error'` |
| `errorCode` | Plumbus error code when `status === 'error'` |
| `userId` | Caller `userId` from auth (often the agent service account) |
| `tenantId` | Caller tenant when set |
| `provider` | `ctx.auth.provider` — usually `'mcp'` or `'anonymous'` |

### Capability errors — `onCapabilityError`

`McpServerConfig.onCapabilityError` fires on the **inline** `tools/call` path when `executeCapability` returns a structured failure (`result.success === false`). It does not fire for task-augmented background jobs (use `onMcpToolCall` with `status: 'error'` there). Same fire-and-forget semantics as `onMcpToolCall`.

## Programmatic API

```typescript
import { createMcpServer, startStdioServer, startHttpServer } from '@plumbus/mcp';

const server = createMcpServer({
  registry,
  db,
  authAdapter,
  createDependencies,
});

// stdio: takes the constructed server
await startStdioServer({ server });

// HTTP: takes config (creates its own Fastify + server internally)
const { close } = await startHttpServer({ config, port: 3001 });
```

The shapes look symmetric but aren't — `startStdioServer` consumes a `Server` you built; `startHttpServer` takes the `McpServerConfig` and constructs its own Fastify instance and server internally. Use `registerMcpOnFastify` when you need to share a Fastify instance with the rest of your app.

Framework apps should prefer `plumbus mcp serve`; the package API is for advanced embedding.

## Capabilities advertisement (with tasks)

The server now advertises:

```ts
{
  capabilities: {
    tools: { listChanged: false },
    tasks: {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    },
  },
}
```

`tasks.requests.tools.call` is the signal MCP clients use to enable the "this tools/call may carry taskMetadata" UX. Clients that do not understand the tasks capability simply ignore it; the inline `tools/call` path keeps working.
