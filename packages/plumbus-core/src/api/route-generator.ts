import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AuthAdapter } from '../auth/adapter.js';
import type { RequestAuthenticator } from '../auth/http-authentication.js';
import { authenticationFailureToHttp, buildAuthenticationRequest } from './authentication-http.js';
import {
  errorToHttpResponse,
  errorToSsePayload,
  GENERIC_INTERNAL_MESSAGE,
  unknownErrorToSsePayload,
} from '../errors/http.js';
import { capabilityHttpMethod } from './exposure.js';
import { isPlumbusError } from '../errors/index.js';
import { logHookError } from '../errors/hook-log.js';
import type { EventQueue } from '../events/queue.js';
import { JobExecutionSource } from '../jobs/schema.js';
import { dispatchQueuedJob } from '../jobs/dispatch.js';
import { evaluateAccess } from '../execution/authorization.js';
import { getCanonicalCapabilityName } from '../execution/canonical-name.js';
import { executeCapability } from '../execution/capability-executor.js';
import type { ContextDependencies } from '../execution/context-factory.js';
import { createExecutionContext } from '../execution/context-factory.js';
import type { CapabilityContract } from '../types/capability.js';
import type { ExecutionContext } from '../types/context.js';

export interface DependencyOptions {
  /** When true, repositories skip tenant-scope filtering (for cross-tenant admin access) */
  bypassTenantScope?: boolean;
  /** Resolved locale for this request (from cookie / Accept-Language) */
  locale?: string;
}

/**
 * A request's dependencies together with the database they were wired against.
 *
 * The generator needs the database as well as the dependencies because two
 * things happen outside the execution context — queue dispatch for `kind: 'job'`
 * capabilities and the `onCapabilityError` hook — and both must address the same
 * database the capability itself read and wrote. Returning them together makes
 * that impossible to get wrong.
 */
export interface ResolvedRequestDependencies {
  /** Dependencies for this request. */
  dependencies: ContextDependencies;
  /** The database `dependencies` were wired against. */
  db: PostgresJsDatabase;
}

export interface RouteGeneratorConfig {
  /**
   * Live Drizzle database connection used by the server.
   *
   * This is the database every request uses unless `resolveDependencies` is
   * supplied, in which case it is only the fallback for requests that never
   * reach dependency resolution.
   */
  db: PostgresJsDatabase;
  /** Auth adapter for extracting identity from requests */
  authAdapter: AuthAdapter;
  /** Optional request-level authenticator (cookies, CSRF, composite bearer precedence) */
  requestAuthenticator?: RequestAuthenticator;
  /** Factory to build base context dependencies for each request */
  createDependencies: (
    auth: NonNullable<Awaited<ReturnType<AuthAdapter['authenticate']>>>,
    options?: DependencyOptions,
  ) => ContextDependencies;
  /**
   * Optional async alternative to `createDependencies`, used for every request
   * when present and ignored when absent.
   *
   * It exists for deployments that choose the request's database per request
   * rather than per boot — a tenant's data plane resolved from its auth context.
   * Leaving it unset keeps the synchronous `createDependencies` path exactly as
   * it was, with no additional `await` between authentication and execution.
   *
   * Throwing rejects the request: the thrown value is mapped through the normal
   * error-to-HTTP rules (a `PlumbusError` keeps its code and status, anything
   * else becomes a generic 500), so a resolver that refuses an unknown or absent
   * tenant fails closed instead of falling through to another tenant's data.
   */
  resolveDependencies?: (
    auth: NonNullable<Awaited<ReturnType<AuthAdapter['authenticate']>>>,
    options?: DependencyOptions,
  ) => Promise<ResolvedRequestDependencies>;
  /** Optional queue for dispatching async job capabilities */
  jobQueue?: EventQueue;
  /** Default locale when request headers do not resolve one */
  defaultLocale?: string;
  /** Locales supported by registered translation definitions */
  supportedLocales?: string[];
  /** Called when a capability execution fails */
  onCapabilityError?: (info: {
    capabilityName: string;
    domain: string;
    errorCode: string;
    errorMessage: string;
    metadata?: Record<string, unknown>;
    userId?: string;
    tenantId?: string;
    sourceIp?: string;
    userAgent?: string;
    db?: PostgresJsDatabase;
  }) => void | Promise<void>;
}

/**
 * Register Fastify routes for a single capability.
 * HTTP method is derived from capability kind:
 *   query → GET, action → POST, job → POST (async), eventHandler → skipped
 */
export function registerCapabilityRoute(
  app: FastifyInstance,
  capability: CapabilityContract,
  config: RouteGeneratorConfig,
): void {
  // Event handlers are internal-only, no HTTP route
  if (capability.kind === 'eventHandler') return;

  const method = capabilityHttpMethod(capability);
  const path = `/api/${capability.domain}/${toKebabCase(capability.name)}`;

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const requestId = resolveRequestCorrelationId(request.headers);

    let authContext: Awaited<ReturnType<AuthAdapter['authenticate']>>;

    if (!config.requestAuthenticator) {
      const authHeader = request.headers.authorization;
      const auth = await config.authAdapter.authenticate(authHeader);
      authContext = auth ?? {
        userId: undefined,
        roles: [],
        scopes: [],
        provider: 'anonymous',
      };
    } else {
      const authResult = await config.requestAuthenticator.authenticate(
        buildAuthenticationRequest(request),
      );

      if (authResult.status === 'authenticated') {
        authContext = authResult.auth;
      } else if (authResult.status === 'anonymous') {
        if (authResult.clearCookieHeader) {
          reply.header('set-cookie', authResult.clearCookieHeader);
        }
        if (!capability.access?.public) {
          reply
            .status(401)
            .header('www-authenticate', 'Bearer')
            .send({
              error: {
                code: 'unauthorized',
                message: 'Authentication required',
                ...(requestId ? { requestId } : {}),
              },
            });
          return;
        }
        authContext = {
          userId: undefined,
          roles: [],
          scopes: [],
          provider: 'anonymous',
        };
      } else {
        const httpFailure = authenticationFailureToHttp(authResult, requestId);
        reply.status(httpFailure.statusCode);
        if (httpFailure.headers) {
          for (const [key, value] of Object.entries(httpFailure.headers)) {
            reply.header(key, value);
          }
        }
        reply.send(httpFailure.body);
        return;
      }
    }

    // 2. Build execution context
    const bypassTenantScope = capability.access?.tenantScoped === false;
    const locale = resolveRequestLocale(request.headers, {
      defaultLocale: config.defaultLocale ?? 'en',
      supportedLocales: config.supportedLocales ?? [config.defaultLocale ?? 'en'],
    });
    // The synchronous factory stays the only path when no resolver is supplied:
    // nothing extra is awaited between authentication and execution.
    let deps: ContextDependencies;
    let requestDb = config.db;
    if (config.resolveDependencies) {
      try {
        const resolved = await config.resolveDependencies(authContext, {
          bypassTenantScope,
          locale,
        });
        deps = resolved.dependencies;
        requestDb = resolved.db;
      } catch (err) {
        const failure = dependencyResolutionToHttp(err, requestId);
        reply.status(failure.statusCode).send(failure.body);
        return;
      }
    } else {
      deps = config.createDependencies(authContext, { bypassTenantScope, locale });
    }
    deps.correlationId = resolveRequestCorrelationId(request.headers);
    deps.request = {
      sourceIp: request.ip,
      userAgent: request.headers['user-agent'],
    };
    const ctx: ExecutionContext = createExecutionContext(deps);
    const canonicalName = getCanonicalCapabilityName(capability);

    // 3. Extract input (query params for GET, body for POST)
    const input =
      method === 'GET' ? coerceQueryParams(request.query, capability.input) : request.body;

    // 4. Execute capability (jobs dispatched async via queue if available)
    if (capability.kind === 'job' && config.jobQueue) {
      const parsed = capability.input.safeParse(input);
      if (!parsed.success) {
        const err = ctx.errors.validation('Invalid input', { capability: canonicalName });
        const { statusCode, body } = errorToHttpResponse(err);
        return reply.status(statusCode).send(body);
      }
      const authz = evaluateAccess(capability.access, ctx.auth);
      if (!authz.allowed) {
        const err = ctx.errors.forbidden(authz.reason ?? 'Access denied', {
          capability: canonicalName,
        });
        const { statusCode, body } = errorToHttpResponse(err);
        return reply.status(statusCode).send(body);
      }
      const jobId = await dispatchQueuedJob({
        db: requestDb,
        jobQueue: config.jobQueue,
        capability,
        input: parsed.data as Record<string, unknown>,
        auth: ctx.auth,
        source: JobExecutionSource.Http,
      });
      reply.status(202).send({ data: { jobId, status: 'accepted' } });
      return;
    }

    const result = await executeCapability(capability, ctx, input);

    if (result.success) {
      reply.status(200).send({ data: result.data });
    } else {
      const httpError = errorToHttpResponse(result.error);
      reply.status(httpError.statusCode).send(httpError.body);

      // Fire error hook (fire-and-forget, never blocks the response).
      // IIFE so a sync throw inside the hook is caught by .catch.
      if (config.onCapabilityError) {
        void (async () =>
          config.onCapabilityError?.({
            capabilityName: capability.name,
            domain: capability.domain,
            errorCode: result.error.code,
            errorMessage: result.error.message,
            metadata: result.error.metadata,
            userId: ctx.auth.userId,
            tenantId: ctx.auth.tenantId,
            sourceIp: request.ip,
            userAgent: request.headers['user-agent'],
            db: requestDb,
          }))().catch((hookErr) => {
          logHookError('onCapabilityError', hookErr);
        });
      }
    }
  };

  /*
   * Every method a capability may declare, not just the two the `kind` fallback produces. A
   * declared `PATCH` that silently registered as `POST` is the same defect as a declared `POST`
   * served as `GET`: the contract says one thing and the wire does another.
   */
  switch (method) {
    case 'GET':
      app.get(path, handler);
      break;
    case 'PATCH':
      app.patch(path, handler);
      break;
    case 'PUT':
      app.put(path, handler);
      break;
    case 'DELETE':
      app.delete(path, handler);
      break;
    default:
      app.post(path, handler);
  }
}

/**
 * Register routes for multiple capabilities at once.
 */
export function registerAllRoutes(
  app: FastifyInstance,
  capabilities: CapabilityContract[],
  config: RouteGeneratorConfig,
): void {
  for (const cap of capabilities) {
    registerCapabilityRoute(app, cap, config);
  }
}

/**
 * Register a streaming SSE endpoint for a capability.
 * The callback receives an ExecutionContext and input, and should yield AIStreamEvents
 * via ctx.ai.streamGenerate(). Events are forwarded to the client as SSE.
 *
 * Path: POST /api/{domain}/{capability-name}/stream
 */
export function registerStreamingRoute(
  app: FastifyInstance,
  capability: CapabilityContract,
  config: RouteGeneratorConfig,
  streamHandler: (
    ctx: ExecutionContext,
    input: Record<string, unknown>,
  ) => AsyncIterable<import('../types/context.js').AIStreamEvent>,
): void {
  const path = `/api/${capability.domain}/${toKebabCase(capability.name)}/stream`;

  app.post(path, async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = resolveRequestCorrelationId(request.headers);

    let authContext: Awaited<ReturnType<AuthAdapter['authenticate']>>;

    if (!config.requestAuthenticator) {
      const authHeader = request.headers.authorization;
      const auth = await config.authAdapter.authenticate(authHeader);
      authContext = auth ?? {
        userId: undefined,
        roles: [],
        scopes: [],
        provider: 'anonymous',
      };
    } else {
      const authResult = await config.requestAuthenticator.authenticate(
        buildAuthenticationRequest(request),
      );

      if (authResult.status === 'authenticated') {
        authContext = authResult.auth;
      } else if (authResult.status === 'anonymous') {
        if (authResult.clearCookieHeader) {
          reply.header('set-cookie', authResult.clearCookieHeader);
        }
        if (!capability.access?.public) {
          reply
            .status(401)
            .header('www-authenticate', 'Bearer')
            .send({
              error: {
                code: 'unauthorized',
                message: 'Authentication required',
                ...(requestId ? { requestId } : {}),
              },
            });
          return;
        }
        authContext = {
          userId: undefined,
          roles: [],
          scopes: [],
          provider: 'anonymous',
        };
      } else {
        const httpFailure = authenticationFailureToHttp(authResult, requestId);
        reply.status(httpFailure.statusCode);
        if (httpFailure.headers) {
          for (const [key, value] of Object.entries(httpFailure.headers)) {
            reply.header(key, value);
          }
        }
        reply.send(httpFailure.body);
        return;
      }
    }

    // 2. Build context
    const bypassTenantScope = capability.access?.tenantScoped === false;
    const locale = resolveRequestLocale(request.headers, {
      defaultLocale: config.defaultLocale ?? 'en',
      supportedLocales: config.supportedLocales ?? [config.defaultLocale ?? 'en'],
    });
    let deps: ContextDependencies;
    if (config.resolveDependencies) {
      try {
        const resolved = await config.resolveDependencies(authContext, {
          bypassTenantScope,
          locale,
        });
        deps = resolved.dependencies;
      } catch (err) {
        const failure = dependencyResolutionToHttp(err, requestId);
        reply.status(failure.statusCode).send(failure.body);
        return;
      }
    } else {
      deps = config.createDependencies(authContext, { bypassTenantScope, locale });
    }
    deps.correlationId = resolveRequestCorrelationId(request.headers);
    deps.request = {
      sourceIp: request.ip,
      userAgent: request.headers['user-agent'],
    };
    const ctx: ExecutionContext = createExecutionContext(deps);
    const canonicalName = getCanonicalCapabilityName(capability);

    // 3. Extract input
    const input = (request.body ?? {}) as Record<string, unknown>;

    const authz = evaluateAccess(capability.access, ctx.auth);
    if (!authz.allowed) {
      const err = ctx.errors.forbidden(authz.reason ?? 'Access denied', {
        capability: canonicalName,
      });
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      reply.raw.write(`data: ${JSON.stringify(errorToSsePayload(err))}\n\n`);
      reply.raw.end();
      return;
    }
    const parsed = capability.input.safeParse(input);
    if (!parsed.success) {
      const err = ctx.errors.validation('Invalid input', { capability: canonicalName });
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      reply.raw.write(`data: ${JSON.stringify(errorToSsePayload(err))}\n\n`);
      reply.raw.end();
      return;
    }

    // 4. Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      for await (const event of streamHandler(ctx, parsed.data as Record<string, unknown>)) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const payload = unknownErrorToSsePayload(err);
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    reply.raw.end();
  });
}

/**
 * Shape a failure from `resolveDependencies` into an HTTP response.
 *
 * A `PlumbusError` keeps its own code and status — a resolver that refuses an
 * unknown tenant with `notFound`, or an untenanted request with `forbidden`,
 * reaches the client as that. Anything else becomes a generic 500 so an
 * infrastructure failure (a connection string, a routing table) is never echoed
 * back to the caller. Streaming routes call this before any SSE header is
 * written, so the refusal is a plain HTTP status there too.
 */
function dependencyResolutionToHttp(
  err: unknown,
  requestId: string | undefined,
): {
  statusCode: number;
  body: { error: { code: string; message: string; metadata?: Record<string, unknown> } };
} {
  const mapped = isPlumbusError(err)
    ? errorToHttpResponse(err)
    : {
        statusCode: 500,
        body: { error: { code: 'internal', message: GENERIC_INTERNAL_MESSAGE } },
      };
  return {
    statusCode: mapped.statusCode,
    body: { error: { ...mapped.body.error, ...(requestId ? { requestId } : {}) } },
  };
}

function resolveRequestCorrelationId(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  for (const key of ['x-correlation-id', 'x-request-id']) {
    const value = headers[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export const LOCALE_COOKIE_NAME = 'plumbus-ui-locale';

export interface ResolveRequestLocaleOptions {
  defaultLocale: string;
  supportedLocales: string[];
  cookieName?: string;
}

/**
 * Resolve request locale from the `plumbus-ui-locale` cookie, then Accept-Language,
 * falling back to `defaultLocale`.
 */
export function resolveRequestLocale(
  headers: Record<string, string | string[] | undefined>,
  options: ResolveRequestLocaleOptions,
): string {
  const { defaultLocale, supportedLocales, cookieName = LOCALE_COOKIE_NAME } = options;
  const supported = new Set(supportedLocales);

  const cookieHeader = headers.cookie;
  if (typeof cookieHeader === 'string') {
    const pattern = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`);
    const match = pattern.exec(cookieHeader);
    const cookieLocale = match?.[1]?.trim();
    if (cookieLocale && supported.has(cookieLocale)) {
      return cookieLocale;
    }
  }

  const acceptLanguage = headers['accept-language'];
  if (typeof acceptLanguage === 'string') {
    const candidates = acceptLanguage
      .split(',')
      .map((part) => {
        const [tag, qPart] = part.trim().split(';');
        const q = qPart?.trim().startsWith('q=') ? Number.parseFloat(qPart.trim().slice(2)) : 1;
        return { tag: tag?.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
      })
      .filter((entry) => entry.tag)
      .sort((a, b) => b.q - a.q);

    for (const { tag } of candidates) {
      if (!tag) continue;
      if (supported.has(tag)) return tag;
      const langPrefix = tag.split('-')[0];
      if (langPrefix) {
        for (const locale of supportedLocales) {
          if (locale === langPrefix || locale.startsWith(`${langPrefix}-`)) {
            return locale;
          }
        }
      }
    }
  }

  return defaultLocale;
}

/** Match `plumbus generate` / OpenAPI paths (camelCase and snake_case → kebab-case). */
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/**
 * Coerce query-string values (always strings) to the types expected by the Zod schema.
 * Handles number and boolean coercion for top-level fields in ZodObject schemas.
 */
function coerceQueryParams(query: unknown, schema: z.ZodTypeAny): Record<string, unknown> {
  const raw = (query ?? {}) as Record<string, unknown>;
  const shape = getSchemaShape(schema);
  if (!shape) return raw;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      result[key] = value;
      continue;
    }
    const expectedType = getExpectedType(shape[key]);
    if (expectedType === 'number') {
      const n = Number(value);
      result[key] = Number.isNaN(n) ? value : n;
    } else if (expectedType === 'boolean') {
      result[key] = value === 'true' ? true : value === 'false' ? false : value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Unwrap ZodOptional / ZodDefault / ZodNullable to find the inner type name. */
function getExpectedType(field: z.ZodTypeAny | undefined): string | undefined {
  if (!field) return undefined;
  const typeName = (field as any)._def?.typeName as string | undefined;
  if (typeName === 'ZodNumber') return 'number';
  if (typeName === 'ZodBoolean') return 'boolean';
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault' || typeName === 'ZodNullable') {
    return getExpectedType((field as any)._def?.innerType);
  }
  return typeName;
}

/** Extract the shape from a ZodObject, unwrapping ZodEffects if needed. */
function getSchemaShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
  const def = (schema as any)._def;
  if (!def) return undefined;
  if (def.typeName === 'ZodObject') return def.shape?.() ?? def.shape;
  if (def.typeName === 'ZodEffects') return getSchemaShape(def.schema);
  return undefined;
}
