import type { CapabilityContract, ExecutionContext } from '@plumbus/core';
import { executeCapability } from '@plumbus/core';
import type { z } from '@plumbus/core/zod';
import type { ContextSource } from '../types/context.js';
import type { TurnContext } from '../types/turn.js';

export function capabilityContext<Cap extends CapabilityContract>(
  capability: Cap,
  opts?: {
    buildInput?: (turnCtx: TurnContext) => z.infer<Cap['input']>;
    sourceId?: string;
  },
): ContextSource {
  const effects = capability.effects;
  if (effects.data.length > 0 || effects.events.length > 0) {
    throw new Error(
      `capabilityContext: "${capability.name}" has write effects and cannot be used as a read-only context source`,
    );
  }

  return {
    kind: 'capability',
    id: capability.name,
    async resolve(ctx: ExecutionContext, turnCtx: TurnContext) {
      const input = opts?.buildInput?.(turnCtx) ?? {};
      const result = await executeCapability(capability, ctx, input);
      const content = result.success ? result.data : { error: result.error?.message };
      const text = JSON.stringify(content);
      return {
        items: [
          {
            id: `${capability.name}:result`,
            kind: 'json',
            content,
            sourceId: opts?.sourceId ?? capability.name,
          },
        ],
        sources: [],
        estimatedTokens: Math.ceil(text.length / 4),
      };
    },
  };
}
