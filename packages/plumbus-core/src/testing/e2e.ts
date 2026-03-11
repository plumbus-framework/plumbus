// ── E2E Test Utilities ──
// Helpers for end-to-end testing with Vitest Browser Mode.
// Provides server lifecycle management and HTTP client helpers.

import { EntityRegistry } from "../data/registry.js";
import { ConsumerRegistry } from "../events/consumer-registry.js";
import { EventRegistry } from "../events/registry.js";
import { CapabilityRegistry } from "../execution/capability-registry.js";
import { FlowRegistry } from "../flows/registry.js";
import { createServer, type PlumbusServer } from "../server/bootstrap.js";
import type { CapabilityContract } from "../types/capability.js";
import type { PlumbusConfig } from "../types/config.js";
import type { LoggerService } from "../types/context.js";
import type { AuthContext } from "../types/security.js";

// ── E2E Config ──

export interface E2EServerOptions {
  /** Capabilities to register */
  capabilities?: CapabilityContract[];
  /** Config overrides */
  config?: Partial<PlumbusConfig>;
  /** Port (default: random available) */
  port?: number;
  /** Suppress server logs in test output */
  silent?: boolean;
}

export interface E2EServerContext {
  /** Running server instance */
  server: PlumbusServer;
  /** Base URL of the server (e.g., http://127.0.0.1:12345) */
  baseUrl: string;
  /** Shut down the server */
  close(): Promise<void>;
  /** Make a typed fetch call to a capability route */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

// ── Silent Logger ──

function silentLogger(): LoggerService {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

// ── Minimal DB Stub ──
// For E2E tests that don't need a real DB, provide a stub
// that satisfies the type signature.

function createDbStub(): any {
  return {
    execute: async () => [],
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
}

// ── Default Test Config ──

function defaultTestConfig(overrides?: Partial<PlumbusConfig>): PlumbusConfig {
  return {
    appName: "e2e-test-app",
    environment: "production",
    port: 0,
    database: { connectionString: "postgresql://test:test@localhost:5432/test" },
    auth: { secret: "e2e-test-secret", providers: [] },
    ...overrides,
  } as PlumbusConfig;
}

/**
 * Create an E2E test server with registered capabilities.
 *
 * Usage in Vitest Browser Mode:
 * ```ts
 * let e2e: E2EServerContext;
 *
 * beforeAll(async () => {
 *   e2e = await createE2EServer({ capabilities: [myCapability] });
 * });
 *
 * afterAll(async () => {
 *   await e2e.close();
 * });
 *
 * it("responds to capability route", async () => {
 *   const res = await e2e.fetch("/api/my-capability", {
 *     method: "POST",
 *     body: JSON.stringify({ input: "test" }),
 *   });
 *   expect(res.ok).toBe(true);
 * });
 * ```
 */
export async function createE2EServer(
  options?: E2EServerOptions,
): Promise<E2EServerContext> {
  const capabilities = new CapabilityRegistry();
  if (options?.capabilities) {
    for (const cap of options.capabilities) {
      capabilities.register(cap);
    }
  }

  const config = defaultTestConfig(options?.config);
  const port = options?.port ?? 0; // 0 = random port

  const server = createServer({
    config,
    db: createDbStub(),
    capabilities,
    entities: new EntityRegistry(),
    events: new EventRegistry(),
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    host: "127.0.0.1",
    port,
    logger: silentLogger(),
  });

  const address = await server.start();

  // Parse host:port from the Fastify address string
  const baseUrl = address.startsWith("http") ? address : `http://${address}`;

  return {
    server,
    baseUrl,
    async close() {
      await server.stop();
    },
    async fetch(path: string, init?: RequestInit) {
      const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
      return globalThis.fetch(url, {
        headers: { "content-type": "application/json", ...init?.headers },
        ...init,
      });
    },
  };
}

// ── Auth Token Helper ──

/**
 * Create a fake Authorization header for E2E tests.
 * This generates a base64-encoded JSON payload that matches the expected token format.
 * Only works when the server is configured with the default test secret.
 */
export function createTestBearerHeader(auth?: Partial<AuthContext>): { authorization: string } {
  // Create a minimal JWT-style token for test auth adapters
  const payload = {
    sub: auth?.userId ?? "e2e-user",
    roles: auth?.roles ?? ["user"],
    tenantId: auth?.tenantId ?? "e2e-tenant",
  };
  const encoded = btoa(JSON.stringify(payload));
  return { authorization: `Bearer test.${encoded}.sig` };
}
