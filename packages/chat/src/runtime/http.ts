import type { FastifyInstance } from 'fastify';
import { z } from '@plumbus/core/zod';
import type { RouteGeneratorConfig } from '@plumbus/core';
import { createExecutionContext } from '@plumbus/core';
import type { ChatDefinition } from '../types/chat.js';
import { runChatTurn } from './run-turn.js';
import { capClientHistory, validateClientHistorySize } from './constants.js';

const turnBodySchema = z.object({
  sessionId: z.string().uuid(),
  userMessage: z.string().min(1),
  audience: z.string(),
  locale: z.string(),
  clientHistory: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
    .optional(),
});

export function registerChatRoutes(
  app: FastifyInstance,
  routeConfig: RouteGeneratorConfig,
  chats: ChatDefinition[],
): void {
  const byName = new Map(chats.map((c) => [c.name, c]));

  for (const chat of chats) {
    const expose = chat.exposeAs ?? 'sse';
    if (expose === 'capability') continue;

    app.post(`/chat/${chat.name}/turn`, async (req, reply) => {
      const authHeader = req.headers.authorization;
      const auth = await routeConfig.authAdapter.authenticate(authHeader);
      if (!auth) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const parsed = turnBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
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

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const definition = byName.get(chat.name);
      if (!definition) {
        reply.raw.write(
          `data: ${JSON.stringify({ type: 'turn.failed', code: 'chat.not_found', message: 'Chat not found' })}\n\n`,
        );
        reply.raw.end();
        return;
      }

      for await (const evt of runChatTurn(ctx, {
        chatDefinition: definition,
        sessionId: parsed.data.sessionId,
        userMessage: parsed.data.userMessage,
        audience: parsed.data.audience,
        locale: parsed.data.locale,
        clientHistory: capClientHistory(parsed.data.clientHistory),
      })) {
        reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
      reply.raw.end();
    });
  }
}
