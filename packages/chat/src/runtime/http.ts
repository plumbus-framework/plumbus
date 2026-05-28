import type { ExecutionContext } from '@plumbus/core';
import type { RouteGeneratorConfig } from '@plumbus/core';
import { createExecutionContext } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChatDefinition } from '../types/chat.js';
import type { ChatEvent } from '../types/event.js';
import { capClientHistory, validateClientHistorySize } from './constants.js';
import { runChatTurn } from './run-turn.js';

const turnBodySchema = z
  .object({
    sessionId: z.string().uuid(),
    userMessage: z.string().min(1),
    audience: z.string(),
    locale: z.string(),
    // `refusalReason` lets ephemeral chats (`saveToDb: false`) enforce the
    // behavioral cooldown guard from clientHistory alone — the client (which
    // sees turn.completed's refusalReason on each assistant message) carries
    // the flag back per turn. Optional + nullable so legacy clients still
    // validate.
    clientHistory: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string(),
          refusalReason: z
            .enum(['off_topic', 'unsafe', 'asking_for_action', 'pii_request'])
            .nullable()
            .optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

export type ChatTurnParsedBody = z.infer<typeof turnBodySchema>;

export interface RegisterChatRoutesOpts {
  authCookieNames?: string[];
  audienceTenantOverride?: (audience: string, auth: { tenantId?: string }) => string | undefined;
  beforeTurn?: (
    ctx: ExecutionContext,
    parsed: ChatTurnParsedBody,
    rawBody: unknown,
  ) => Promise<{ userMessage?: string } | { error: { status: number; body: unknown } }>;
  afterTurn?: (ctx: ExecutionContext, rawBody: unknown, events: ChatEvent[]) => Promise<void>;
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const cookies = (req as { cookies?: Record<string, string> }).cookies;
  if (cookies?.[name]) return cookies[name];
  const header = req.headers.cookie;
  if (!header || typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function resolveAuthToken(req: FastifyRequest, cookieNames: string[]): string | undefined {
  const headerToken = req.headers.authorization;
  if (headerToken) return headerToken;
  for (const name of cookieNames) {
    const value = readCookie(req, name);
    if (value) return `Bearer ${value}`;
  }
  return undefined;
}

export function registerChatRoutes(
  app: FastifyInstance,
  routeConfig: RouteGeneratorConfig,
  chats: ChatDefinition[],
  opts?: RegisterChatRoutesOpts,
): void {
  const byName = new Map(chats.map((c) => [c.name, c]));
  const cookieNames = opts?.authCookieNames ?? [];

  for (const chat of chats) {
    const expose = chat.exposeAs ?? 'sse';
    if (expose === 'capability') continue;

    const streaming = chat.streaming ?? true;

    app.post(`/chat/${chat.name}/turn`, async (req, reply) => {
      const tokenForAuth = resolveAuthToken(req, cookieNames);
      let auth = await routeConfig.authAdapter.authenticate(tokenForAuth);
      if (!auth) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const parsed = turnBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
      }

      const overriddenTenant = opts?.audienceTenantOverride?.(parsed.data.audience, auth);
      if (overriddenTenant && !auth.tenantId) {
        auth = { ...auth, tenantId: overriddenTenant };
      }

      try {
        validateClientHistorySize(parsed.data.clientHistory);
      } catch {
        return reply.status(400).send({ error: { code: 'chat.client_history_too_large' } });
      }

      const deps = routeConfig.createDependencies(auth);
      deps.request = {
        sourceIp: req.ip,
        userAgent: req.headers['user-agent'],
      };
      const ctx = createExecutionContext(deps);

      let effectiveUserMessage = parsed.data.userMessage;
      if (opts?.beforeTurn) {
        const result = await opts.beforeTurn(ctx, parsed.data, req.body);
        if ('error' in result) {
          return reply.status(result.error.status).send(result.error.body);
        }
        if (result.userMessage !== undefined) {
          effectiveUserMessage = result.userMessage;
        }
      }

      const definition = byName.get(chat.name);
      if (!definition) {
        if (!streaming) {
          return reply.status(404).send({
            events: [
              {
                type: 'turn.failed',
                code: 'chat.not_found',
                message: 'Chat not found',
              },
            ],
          });
        }
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        reply.raw.write(
          `data: ${JSON.stringify({ type: 'turn.failed', code: 'chat.not_found', message: 'Chat not found' })}\n\n`,
        );
        reply.raw.end();
        return;
      }

      const runArgs = {
        chatDefinition: definition,
        sessionId: parsed.data.sessionId,
        userMessage: effectiveUserMessage,
        audience: parsed.data.audience,
        locale: parsed.data.locale,
        clientHistory: capClientHistory(parsed.data.clientHistory),
      };

      if (!streaming) {
        const events: ChatEvent[] = [];
        for await (const evt of runChatTurn(ctx, runArgs)) {
          events.push(evt);
        }
        if (opts?.afterTurn) {
          try {
            await opts.afterTurn(ctx, req.body, events);
          } catch (err) {
            console.warn('[registerChatRoutes] afterTurn hook failed:', err);
          }
        }
        return reply.send({ events });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const events: ChatEvent[] = [];
      for await (const evt of runChatTurn(ctx, runArgs)) {
        events.push(evt);
        reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
      reply.raw.end();

      if (opts?.afterTurn) {
        try {
          await opts.afterTurn(ctx, req.body, events);
        } catch (err) {
          console.warn('[registerChatRoutes] afterTurn hook failed:', err);
        }
      }
    });
  }
}
