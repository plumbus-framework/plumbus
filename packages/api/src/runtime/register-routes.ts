import {
  buildAuthenticationRequest,
  evaluateAccess,
  executeCapability,
  isApiExposed,
  type AuthContext,
  type CapabilityContract,
  type RouteGeneratorConfig,
} from '@plumbus/core';
import { createExecutionContext } from '@plumbus/core/runtime';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { apiVersionFromManifest, joinApiPath } from '../manifest/api-version.js';
import { requiredApiScopes } from '../manifest/scopes.js';
import { buildDefaultManifest } from '../manifest/default-manifest.js';
import {
  mergePathParamsIntoInput,
  PathParamCollisionError,
  toFastifyPath,
} from '../manifest/path-params.js';
import { resolveExposure } from '../manifest/resolve.js';
import type { ApiManifest, ApiManifestEntry } from '../manifest/types.js';
import {
  buildSuccessEnvelope,
  mapAuthenticationUnavailable,
  mapCoreError,
  mapCsrfFailed,
  mapMissingScope,
  mapTenantBoundaryViolation,
  mapUnauthenticated,
  mapUnknownError,
  toPlumbusErrorLike,
  type ApiErrorEnvelope,
} from './envelope.js';
import {
  buildIdempotencyStoreKey,
  createInMemoryIdempotencyStore,
  hashPayload,
  IdempotencyAbortedError,
  isAnonymousIdempotencyPrincipal,
  parseIdempotencyTtl,
  type IdempotencyPrincipal,
  type IdempotencyStore,
  type IdempotencyStoreOptions,
} from './idempotency.js';
import { coerceQueryParams } from './coerce-query.js';
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
  idempotencyStore?: IdempotencyStore;
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
  const idempotencyStore = opts?.idempotencyStore ?? createInMemoryIdempotencyStore();
  const apiVersion = apiVersionFromManifest(manifest);

  for (const cap of capabilities) {
    if (!isApiExposed(cap)) {
      continue;
    }

    const entry = findManifestEntry(manifest, cap);
    const resolved = resolveExposure(cap, entry);
    const fullPath = joinApiPath(manifest.basePath, resolved.path);

    const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const requestId = crypto.randomUUID();

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

        const parsed = cap.input.safeParse(rawInput);
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
          if (isAnonymousIdempotencyPrincipal(principal)) {
            const mapped = mapUnauthenticated(requestId, apiVersion);
            return reply.status(mapped.status).send(mapped.body);
          }
          const storeKey = buildIdempotencyStoreKey(resolved.operationId, principal, idemKey);
          const payloadHash = hashPayload(parsed.data);
          const ttlMs =
            resolved.idempotency.ttl !== undefined
              ? parseIdempotencyTtl(resolved.idempotency.ttl)
              : undefined;
          const storeOpts: IdempotencyStoreOptions | undefined =
            ttlMs !== undefined ? { ttlMs } : undefined;

          let claim = await idempotencyStore.claim(storeKey, payloadHash, principal, storeOpts);

          for (;;) {
            if (claim.status === 'replay') {
              return reply
                .status(200)
                .send(buildSuccessEnvelope(claim.record.result, requestId, apiVersion));
            }

            if (claim.status === 'conflict') {
              const message =
                claim.reason === 'principal'
                  ? 'Idempotency key belongs to a different principal'
                  : 'Idempotency key reused with different payload';
              return reply.status(409).send({
                ok: false,
                error: {
                  code: 'idempotency_conflict',
                  message,
                  requestId,
                },
                meta: { apiVersion },
              });
            }

            if (claim.status === 'in-flight') {
              try {
                const record = await claim.wait;
                return reply
                  .status(200)
                  .send(buildSuccessEnvelope(record.result, requestId, apiVersion));
              } catch (waitErr) {
                if (!(waitErr instanceof IdempotencyAbortedError)) {
                  throw waitErr;
                }
                claim = await idempotencyStore.claim(storeKey, payloadHash, principal, storeOpts);
                continue;
              }
            }

            break;
          }

          let result: Awaited<ReturnType<typeof executeCapability>>;
          try {
            result = await executeCapability(cap, ctx, parsed.data);
          } catch (execErr) {
            await idempotencyStore.abort(storeKey);
            throw execErr;
          }
          if (!result.success) {
            await idempotencyStore.abort(storeKey);
            const mapped = mapCoreError(result.error, requestId, apiVersion);
            return reply.status(mapped.status).send(mapped.body);
          }

          await idempotencyStore.complete(storeKey, result.data, storeOpts);
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
