import { evaluateAccess } from '@plumbus/core';
import type { RouteGeneratorConfig } from '@plumbus/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchVoiceProviderOptions } from '../catalog/fetch-options.js';
import { listVoiceProviderCatalog, suggestVoiceStacks } from '../catalog/list-catalog.js';
import type { RegisterVoiceRoutesOpts } from '../types/http.js';
import type { VoiceDefinition } from '../types/voice.js';

export function registerVoiceCatalogRoutes(
  app: FastifyInstance,
  routeConfig: RouteGeneratorConfig,
  voices: VoiceDefinition[],
  opts: RegisterVoiceRoutesOpts,
): void {
  const cookieNames = opts.authCookieNames ?? [];

  app.get('/api/voice/catalog', async (req, reply) => {
    const auth = await authenticateAdmin(req, routeConfig, cookieNames);
    if (!auth.ok) return reply.status(auth.status).send(auth.body);

    return reply.send({
      catalog: listVoiceProviderCatalog(),
      voices: voices.map((voice) => voice.name),
    });
  });

  app.get('/api/voice/catalog/:kind/:providerId/options', async (req, reply) => {
    const auth = await authenticateAdmin(req, routeConfig, cookieNames);
    if (!auth.ok) return reply.status(auth.status).send(auth.body);

    const params = req.params as { kind: 'transport' | 'stt' | 'tts'; providerId: string };
    const options =
      params.kind === 'transport'
        ? {
            providerId: params.providerId,
            kind: 'stt' as const,
            models: [],
            voices: [],
            source: 'static' as const,
            partial: false,
          }
        : await fetchVoiceProviderOptions({
            kind: params.kind,
            providerId: params.providerId,
            providers: opts.providers,
            registry: opts.registry,
          });
    return reply.send(options);
  });

  app.get('/api/voice/stacks', async (req, reply) => {
    const auth = await authenticateAdmin(req, routeConfig, cookieNames);
    if (!auth.ok) return reply.status(auth.status).send(auth.body);

    return reply.send({ stacks: suggestVoiceStacks() });
  });
}

async function authenticateAdmin(
  req: FastifyRequest,
  routeConfig: RouteGeneratorConfig,
  cookieNames: string[],
): Promise<
  | { ok: true }
  | {
      ok: false;
      status: number;
      body: { error: string } | { error: { code: string; message: string } };
    }
> {
  const token = resolveAuthToken(req, cookieNames);
  const auth = await routeConfig.authAdapter.authenticate(token);
  if (!auth) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }

  const authz = evaluateAccess({ roles: ['admin'] }, auth);
  if (!authz.allowed) {
    return {
      ok: false,
      status: 403,
      body: {
        error: { code: 'forbidden', message: authz.reason ?? 'Admin access required' },
      },
    };
  }

  return { ok: true };
}

function resolveAuthToken(req: FastifyRequest, cookieNames: string[]): string | undefined {
  const headerToken = req.headers.authorization;
  if (headerToken) return headerToken;

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;

  for (const cookieName of cookieNames) {
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim();
      if (key !== cookieName) continue;
      return `Bearer ${decodeURIComponent(part.slice(eq + 1).trim())}`;
    }
  }

  return undefined;
}
