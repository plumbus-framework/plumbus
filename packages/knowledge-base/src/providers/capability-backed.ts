import type { CapabilityContract, ExecutionContext } from '@plumbus/core';
import { executeCapability } from '@plumbus/core';
import type { z } from '@plumbus/core/zod';
import type { KnowledgeProvider } from '../types/provider.js';
import type { KnowledgeScope } from '../types/scope.js';
import { KnowledgeError, KnowledgeErrorCode, knowledgeError } from '../internal/knowledge-error.js';

function assertReadOnlyCapability<Cap extends CapabilityContract>(capability: Cap): void {
  const effects = capability.effects;
  if (
    effects.data.length > 0 ||
    effects.events.length > 0 ||
    effects.external.length > 0 ||
    effects.ai !== false
  ) {
    knowledgeError(
      KnowledgeErrorCode.capabilityNotReadonly,
      `capability "${capability.name}" has side effects and cannot back a knowledge source`,
    );
  }
}

export function capabilityBacked<Cap extends CapabilityContract>(opts: {
  capability: Cap;
  buildInput?: (scope: KnowledgeScope) => z.infer<Cap['input']>;
  format?: (output: z.infer<Cap['output']>) => string;
}): KnowledgeProvider {
  assertReadOnlyCapability(opts.capability);

  return {
    async getBlock(ctx: ExecutionContext, scope) {
      const input = opts.buildInput?.(scope) ?? ({} as z.infer<Cap['input']>);
      const result = await executeCapability(opts.capability, ctx, input);
      if (!result.success) {
        return JSON.stringify({ error: result.error?.message ?? 'capability failed' });
      }
      if (opts.format) return opts.format(result.data);
      return JSON.stringify(result.data);
    },
    async getTools() {
      throw new KnowledgeError(KnowledgeErrorCode.tierNotSupported, 'tier 2 getTools');
    },
    async search() {
      throw new KnowledgeError(KnowledgeErrorCode.tierNotSupported, 'tier 3 search');
    },
  };
}
