import {
  type AuthContext,
  authorizeCapability,
  buildAuthenticationRequest,
  type CapabilityContract,
  evaluateAccess,
  executeCapability,
  executeIdempotently,
  isApiExposed,
  type RouteGeneratorConfig,
  safeParseBounded,
} from '@plumbus/core';
import { createExecutionContext } from '@plumbus/core/runtime';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiManifestError } from '../errors.js';
import { apiVersionFromManifest, joinApiPath } from '../manifest/api-version.js';
import { buildDefaultManifest } from '../manifest/default-manifest.js';
import {
  mergePathParamsIntoInput,
  PathParamCollisionError,
  toFastifyPath,
} from '../manifest/path-params.js';
import { resolveExposure } from '../manifest/resolve.js';
import { requiredApiScopes } from '../manifest/scopes.js';
import type { ApiManifest, ApiManifestEntry } from '../manifest/types.js';
import { coerceQueryParams } from './coerce-query.js';
import {
  type ApiErrorEnvelope,
  buildSuccessEnvelope,
  mapAuthenticationUnavailable,
  mapCoreError,
  mapCsrfFailed,
  mapMissingScope,
  mapTenantBoundaryViolation,
  mapUnauthenticated,
  mapUnknownError,
  toPlumbusErrorLike,
} from './envelope.js';
import {
  buildIdempotencyStoreKey,
  createInMemoryIdempotencyStore,
  hashPayload,
  type IdempotencyPrincipal,
  type IdempotencyStore,
  type IdempotencyStoreOptions,
  isAnonymousIdempotencyPrincipal,
  PayloadTooDeepError,
  parseIdempotencyTtl,
} from './idempotency.js';
import { collectExplicitTenantViolations } from './tenant-boundary.js';
import {
  buildTestEnvelope,
  FixtureReadError,
  FixtureSchemaMismatchError,
  isTestIntent,
  resolveTestMode,
  runSafeReply,
} from './test-intent.js';

export interface RegisterApiRoutesOpts {
  manifest?: ApiManifest;
  /** Allow ?intent=test in addition to the header. Default false. */
  allowQueryIntent?: boolean;
  /** App root for resolving test fixtures. Default process.cwd(). */
  appRoot?: string;
  /**
   * Where `Idempotency-Key` records are kept. Default: the store the core server uses
   * (`routeConfig.idempotencyStore`, e.g. the database store exported from `app/server.ts`),
   * else a process-local in-memory store (production and staging warn about it).
   */
  idempotencyStore?: IdempotencyStore;
  /**
   * Refuse to register `action` and `job` capabilities exposed over `GET`: registration throws
   * `ApiManifestError` with code `api.register.action-over-get`, because cookie CSRF protection
   * does not cover `GET` and a cross-site link could trigger them. Default true. `false` registers
   * such routes and only logs a warning (the pre-0.9 behaviour).
   */
  rejectActionsOverGet?: boolean;
}

let inMemoryIdempotencyProductionWarned = false;

function isProductionEnvironment(): boolean {
  const env = process.env.PLUMBUS_ENV || process.env.NODE_ENV;
  return env === 'production';
}

/** Test hook: reset the one-time in-memory idempotency production warning. */
export function resetIdempotencyWarningForTests(): void {
  inMemoryIdempotencyProductionWarned = false;
}

function warnInMemoryIdempotencyInProduction(app: FastifyInstance, operationIds: string[]): void {
  if (inMemoryIdempotencyProductionWarned || !isProductionEnvironment()) {
    return;
  }
  inMemoryIdempotencyProductionWarned = true;
  app.log.warn(
    { operationIds },
    '[@plumbus/api] Idempotency-Key routes use the default in-memory idempotency store in production. ' +
      'Records are process-local and lost on restart, so duplicate requests can execute twice across ' +
      'restarts or instances. Pass a shared durable store: registerApiRoutes(app, routeConfig, ' +
      'capabilities, { idempotencyStore }).',
  );
}

function checkActionsOverGet(
  app: FastifyInstance,
  routes: { capability: string; operationId: string; path: string }[],
  reject: boolean,
): void {
  if (routes.length === 0) {
    return;
  }
  const names = routes.map((r) => `GET ${r.path} (${r.capability}, ${r.operationId})`);
  if (reject) {
    throw new ApiManifestError(
      `Action and job capabilities must not be exposed via GET (rejectActionsOverGet): ${names.join('; ')}`,
      'api.register.action-over-get',
    );
  }
  app.log.warn(
    { routes: names },
    '[@plumbus/api] Action or job capabilities are exposed via GET (rejectActionsOverGet: false). ' +
      'Cookie CSRF protection only covers POST/PUT/PATCH/DELETE, so a cross-site link or image ' +
      "can trigger them with the visitor's session cookie. Expose them with POST/PATCH/PUT/DELETE " +
      'and remove `rejectActionsOverGet: false`.',
  );
}

function isDeployedEnvironment(): boolean {
  const environment = process.env.PLUMBUS_ENV ?? process.env.NODE_ENV;
  return environment === 'production' || environment === 'staging';
}

function findManifestEntry(
  manifest: ApiManifest,
  cap: CapabilityContract,
): ApiManifestEntry | undefined {
  const key = `${cap.domain}.${cap.name}`;
  return manifest.expose.find((e) => e.capability === key);
}

function registerMethod(
  app: FastifyInstance,
  method: string,
  path: string,
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  const fastifyPath = toFastifyPath(path);
  switch (method) {
    case 'GET':
      app.get(fastifyPath, handler);
      break;
    case 'POST':
      app.post(fastifyPath, handler);
      break;
    case 'PATCH':
      app.patch(fastifyPath, handler);
      break;
    case 'PUT':
      app.put(fastifyPath, handler);
      break;
    case 'DELETE':
      app.delete(fastifyPath, handler);
      break;
    default:
      break;
  }
}

function anonymousAuth(): AuthContext {
  return {
    userId: undefined,
    roles: [],
    scopes: [],
    provider: 'anonymous',
  };
}

async function resolvePartnerAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  routeConfig: RouteGeneratorConfig,
  isPublic: boolean,
  requestId: string,
  apiVersion: string,
): Promise<
  { ok: true; auth: AuthContext } | { ok: false; status: number; body: ApiErrorEnvelope }
> {
  if (!routeConfig.requestAuthenticator) {
    const authHeader = request.headers.authorization;
    const hasAuthHeader = typeof authHeader === 'string' && authHeader.length > 0;

    let auth: Awaited<ReturnType<RouteGeneratorConfig['authAdapter']['authenticate']>>;
    try {
      auth = await routeConfig.authAdapter.authenticate(authHeader);
    } catch {
      return { ok: false, ...mapUnauthenticated(requestId, apiVersion) };
    }

    if (hasAuthHeader && auth === null) {
      return { ok: false, ...mapUnauthenticated(requestId, apiVersion) };
    }

    if (!isPublic && !auth?.userId) {
      return { ok: false, ...mapUnauthenticated(requestId, apiVersion) };
    }

    return { ok: true, auth: auth ?? anonymousAuth() };
  }

  const authResult = await routeConfig.requestAuthenticator.authenticate(
    buildAuthenticationRequest(request),
  );

  if (authResult.status === 'authenticated') {
    return { ok: true, auth: authResult.auth };
  }

  if (authResult.status === 'anonymous') {
    if (authResult.clearCookieHeader) {
      reply.header('set-cookie', authResult.clearCookieHeader);
    }
    if (!isPublic) {
      return { ok: false, ...mapUnauthenticated(requestId, apiVersion) };
    }
    return { ok: true, auth: anonymousAuth() };
  }

  if (authResult.status === 'invalid' && authResult.code === 'csrf_failed') {
    return { ok: false, ...mapCsrfFailed(requestId, apiVersion) };
  }

  if (authResult.status === 'unavailable') {
    return { ok: false, ...mapAuthenticationUnavailable(requestId, apiVersion) };
  }

  return { ok: false, ...mapUnauthenticated(requestId, apiVersion) };
}

export function registerApiRoutes(
  app: FastifyInstance,
  routeConfig: RouteGeneratorConfig,
  capabilities: CapabilityContract[],
  opts?: RegisterApiRoutesOpts,
): void {
  const manifest = opts?.manifest ?? buildDefaultManifest(capabilities);
  const allowQueryIntent = opts?.allowQueryIntent ?? false;
  const appRoot = opts?.appRoot ?? process.cwd();
  const idempotencyStore =
    opts?.idempotencyStore ?? routeConfig.idempotencyStore ?? createInMemoryIdempotencyStore();
  const apiVersion = apiVersionFromManifest(manifest);
  const exposeRequestIds =
    (routeConfig as { requestIds?: { expose?: boolean } }).requestIds?.expose === true;
  if (
    idempotencyStore.kind === 'memory' &&
    isDeployedEnvironment() &&
    capabilities.some(
      (cap) =>
        isApiExposed(cap) &&
        resolveExposure(cap, findManifestEntry(manifest, cap)).idempotency?.required === true,
    )
  ) {
    console.warn(
      '[plumbus/api] Idempotency-Key records are kept in process memory: a retry that reaches another process, or arrives after a restart, runs the request again. Pass a database store (createDatabaseIdempotencyStore) to createServer or registerApiRoutes.',
    );
  }

  const routes = capabilities.filter(isApiExposed).map((cap) => {
    const resolved = resolveExposure(cap, findManifestEntry(manifest, cap));
    return { cap, resolved, fullPath: joinApiPath(manifest.basePath, resolved.path) };
  });

  checkActionsOverGet(
    app,
    routes
      .filter(
        (r) => r.resolved.method === 'GET' && (r.cap.kind === 'action' || r.cap.kind === 'job'),
      )
      .map((r) => ({
        capability: `${r.cap.domain}.${r.cap.name}`,
        operationId: r.resolved.operationId,
        path: r.fullPath,
      })),
    opts?.rejectActionsOverGet !== false,
  );

  if (opts?.idempotencyStore === undefined) {
    const idempotentOps = routes
      .filter((r) => r.resolved.idempotency?.required === true)
      .map((r) => r.resolved.operationId);
    if (idempotentOps.length > 0) {
      warnInMemoryIdempotencyInProduction(app, idempotentOps);
    }
  }

  for (const { cap, resolved, fullPath } of routes) {
    const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      // `requestIds.expose` on the route config (core `createServer({ requestIds })`): the envelope,
      // the `x-request-id` header and the audit row share one id. Off: a fresh envelope id, as before.
      const requestId = exposeRequestIds ? partnerRequestIdOf(request) : crypto.randomUUID();
      if (exposeRequestIds) reply.header('x-request-id', requestId);

      try {
        const headers = request.headers as Record<string, string | string[] | undefined>;
        const query = (request.query ?? {}) as Record<string, unknown>;
        const isPublic = cap.access?.public === true;

        const authResolved = await resolvePartnerAuth(
          request,
          reply,
          routeConfig,
          isPublic,
          requestId,
          apiVersion,
        );
        if (!authResolved.ok) {
          return reply.status(authResolved.status).send(authResolved.body);
        }
        const authContext = authResolved.auth;

        const bypassTenantScope = cap.access?.tenantScoped === false;
        const deps = routeConfig.createDependencies(authContext, { bypassTenantScope });
        // The envelope's requestId is the audit row's correlationId, so support finds the request.
        if (exposeRequestIds) deps.correlationId = requestId;
        deps.request = {
          sourceIp: request.ip,
          userAgent: request.headers['user-agent'],
        };
        const ctx = createExecutionContext(deps);

        const pathParams = (request.params ?? {}) as Record<string, unknown>;
        const bodyOrQuery =
          resolved.method === 'GET' ? coerceQueryParams(request.query, cap.input) : request.body;

        const tenantViolations = collectExplicitTenantViolations(manifest, pathParams, bodyOrQuery);
        if (tenantViolations.length > 0) {
          const mapped = mapTenantBoundaryViolation(tenantViolations, requestId, apiVersion);
          return reply.status(mapped.status).send(mapped.body);
        }

        const apiScopes = requiredApiScopes(resolved.auth?.scopes, cap.access?.scopes);
        if (apiScopes.length > 0) {
          const missing = apiScopes.filter((s) => !ctx.auth.scopes.includes(s));
          if (missing.length > 0) {
            const mapped = mapMissingScope(missing, requestId, apiVersion);
            return reply.status(mapped.status).send(mapped.body);
          }
        }

        const authz = evaluateAccess(cap.access, ctx.auth);
        if (!authz.allowed) {
          const err = ctx.errors.forbidden(authz.reason ?? 'Access denied', {
            capability: cap.name,
          });
          const mapped = mapCoreError(err, requestId, apiVersion);
          return reply.status(mapped.status).send(mapped.body);
        }

        let rawInput: unknown;
        try {
          rawInput = mergePathParamsIntoInput(pathParams, bodyOrQuery);
        } catch (err) {
          if (err instanceof PathParamCollisionError) {
            const validationErr = ctx.errors.validation(err.message, { capability: cap.name });
            const mapped = mapCoreError(validationErr, requestId, apiVersion);
            return reply.status(mapped.status).send(mapped.body);
          }
          throw err;
        }

        const parsed = safeParseBounded(cap.input, rawInput);
        if (!parsed.success) {
          const validationErr = ctx.errors.validation('Invalid input', {
            capability: cap.name,
            issues: parsed.error.issues,
          });
          const mapped = mapCoreError(validationErr, requestId, apiVersion);
          return reply.status(mapped.status).send(mapped.body);
        }

        const testRequested = isTestIntent(headers, query, allowQueryIntent);

        if (testRequested) {
          if (isPublic && resolved.test?.enabled === true) {
            return reply.status(400).send({
              ok: false,
              error: {
                code: 'test_intent_not_supported',
                message: 'Test intent is not supported for public endpoints',
                requestId,
              },
              meta: { apiVersion },
            });
          }

          if (!ctx.auth.userId) {
            const mapped = mapUnauthenticated(requestId, apiVersion);
            return reply.status(mapped.status).send(mapped.body);
          }

          if (resolved.test?.enabled !== true) {
            return reply.status(400).send({
              ok: false,
              error: {
                code: 'test_intent_not_supported',
                message: 'Test intent is not supported for this endpoint',
                requestId,
              },
              meta: { apiVersion },
            });
          }

          const mode = resolveTestMode(resolved.test, headers);
          if (!mode) {
            return reply.status(400).send({
              ok: false,
              error: {
                code: 'test_intent_not_supported',
                message: 'No test mode configured',
                requestId,
              },
              meta: { apiVersion },
            });
          }

          await ctx.audit.record(`api.${resolved.operationId}.test`, {
            mode,
            requestId,
          });

          if (mode === 'validate-only') {
            return reply
              .status(200)
              .send(buildTestEnvelope({ valid: true }, mode, requestId, apiVersion, {}));
          }

          try {
            const safe = await runSafeReply(cap, appRoot, resolved.test.safeReply?.fixture);
            return reply.status(200).send(
              buildTestEnvelope(safe.data, mode, requestId, apiVersion, {
                source: safe.source,
                scenario: safe.scenario,
              }),
            );
          } catch (err) {
            if (err instanceof FixtureSchemaMismatchError) {
              const internal = ctx.errors.internal(err.message);
              const mapped = mapCoreError(internal, requestId, apiVersion);
              return reply.status(mapped.status).send(mapped.body);
            }
            if (err instanceof FixtureReadError) {
              const notFound = ctx.errors.notFound(err.message);
              const mapped = mapCoreError(notFound, requestId, apiVersion);
              return reply.status(mapped.status).send(mapped.body);
            }
            throw err;
          }
        }

        if (resolved.idempotency?.required) {
          const headerName = (resolved.idempotency.header ?? 'Idempotency-Key').toLowerCase();
          const idemKey = request.headers[headerName];
          if (typeof idemKey !== 'string' || idemKey.length === 0) {
            return reply.status(400).send({
              ok: false,
              error: {
                code: 'validation_failed',
                message: `Missing required header: ${resolved.idempotency.header ?? 'Idempotency-Key'}`,
                requestId,
              },
              meta: { apiVersion },
            });
          }

          const principal: IdempotencyPrincipal = {
            userId: ctx.auth.userId,
            tenantId: ctx.auth.tenantId,
          };
          // Callers without a user id share one principal (`operation:tenant::key`), so a claim
          // could not tell them apart and one could replay another's result: refuse them.
          if (!ctx.auth.userId || isAnonymousIdempotencyPrincipal(principal)) {
            const mapped = mapUnauthenticated(requestId, apiVersion);
            return reply.status(mapped.status).send(mapped.body);
          }
          const storeKey = buildIdempotencyStoreKey(resolved.operationId, principal, idemKey);
          // A role or scope change can change what a permitted result may show, so the caller's
          // authority is part of the fingerprint: the same key under other authority is another
          // payload (422), never a replay. Same rule as the core /api surface.
          const authority = hashPayload({
            roles: [...ctx.auth.roles].sort(),
            scopes: [...ctx.auth.scopes].sort(),
          });
          let payloadHash: string;
          try {
            payloadHash = hashPayload({ input: parsed.data, authority });
          } catch (hashErr) {
            if (!(hashErr instanceof PayloadTooDeepError)) throw hashErr;
            return reply.status(400).send({
              ok: false,
              error: {
                code: 'validation_failed',
                message: 'Request body nests too deeply',
                requestId,
              },
              meta: { apiVersion },
            });
          }
          const ttlMs =
            resolved.idempotency.ttl !== undefined
              ? parseIdempotencyTtl(resolved.idempotency.ttl)
              : undefined;
          // Partner routes run on the control plane (`createDependencies`): the key lives there.
          const storeOpts: IdempotencyStoreOptions = {
            ...(ttlMs !== undefined ? { ttlMs } : {}),
            database: routeConfig.db,
            plane: 'spine',
          };

          const outcome = await executeIdempotently({
            store: idempotencyStore,
            key: storeKey,
            payloadHash,
            principal,
            options: storeOpts,
            execute: (executeOptions) => executeCapability(cap, ctx, parsed.data, executeOptions),
          });

          if (outcome.kind === 'replay') {
            // A stored result is still a disclosure. Run the capability's current authorization
            // (access policy and its input-aware `authorize`) for this request without running
            // the handler again — also after waiting on an in-flight duplicate. A caller who would
            // be refused now gets the refusal, not the stored result.
            const authorized = await authorizeCapability(cap, ctx, parsed.data);
            if (!authorized.success) {
              const mapped = mapCoreError(authorized.error, requestId, apiVersion);
              return reply.status(mapped.status).send(mapped.body);
            }
            return reply
              .status(200)
              .send(buildSuccessEnvelope(outcome.result, requestId, apiVersion));
          }

          if (outcome.kind === 'conflict') {
            // Another payload under the same key is unprocessable (422); another principal's
            // key conflicts (409).
            const payload = outcome.reason === 'payload';
            return reply.status(payload ? 422 : 409).send({
              ok: false,
              error: {
                code: 'idempotency_conflict',
                message: payload
                  ? 'Idempotency key reused with different payload'
                  : 'Idempotency key belongs to a different principal',
                requestId,
              },
              meta: { apiVersion },
            });
          }

          if (outcome.kind === 'in-progress') {
            return reply
              .status(409)
              .header('retry-after', String(outcome.retryAfterSeconds))
              .send({
                ok: false,
                error: {
                  code: 'idempotency_in_progress',
                  message: 'A request with this idempotency key is in progress',
                  requestId,
                },
                meta: { apiVersion },
              });
          }

          const result = outcome.result;
          if (!result.success) {
            const mapped = mapCoreError(result.error, requestId, apiVersion);
            return reply.status(mapped.status).send(mapped.body);
          }

          await ctx.audit.record(`api.${resolved.operationId}`, { requestId, live: true });
          return reply.status(200).send(buildSuccessEnvelope(result.data, requestId, apiVersion));
        }

        const result = await executeCapability(cap, ctx, parsed.data);
        if (result.success) {
          await ctx.audit.record(`api.${resolved.operationId}`, { requestId, live: true });
          return reply.status(200).send(buildSuccessEnvelope(result.data, requestId, apiVersion));
        }

        const plumbusErr = toPlumbusErrorLike(result.error);
        if (plumbusErr) {
          const mapped = mapCoreError(plumbusErr, requestId, apiVersion);
          return reply.status(mapped.status).send(mapped.body);
        }
        const unknown = mapUnknownError(requestId, apiVersion);
        return reply.status(unknown.status).send(unknown.body);
      } catch {
        const unknown = mapUnknownError(requestId, apiVersion);
        return reply.status(unknown.status).send(unknown.body);
      }
    };

    registerMethod(app, resolved.method, fullPath, handler);
  }
}

const WELL_FORMED_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/**
 * Under `requestIds.expose`, the request id an envelope carries: the id Fastify assigned when it is
 * well formed, else a new UUID.
 *
 * Under `@plumbus/core` `createServer` (0.9.0-beta.9+), Fastify's `request.id` is core's request
 * id — a caller's well-formed `x-request-id`/`x-correlation-id`, or a UUID — so this envelope, the
 * `x-request-id` header, the server log line's `reqId` and the audit `correlationId` agree. Same
 * rule as core's `isWellFormedRequestId`, restated so this package keeps its existing core peer
 * floor; Fastify's own default ids (`req-1`) are too short to pass and get a UUID.
 */
function partnerRequestIdOf(request: FastifyRequest): string {
  const assigned = (request as { id?: unknown }).id;
  return typeof assigned === 'string' && WELL_FORMED_REQUEST_ID.test(assigned)
    ? assigned
    : crypto.randomUUID();
}
