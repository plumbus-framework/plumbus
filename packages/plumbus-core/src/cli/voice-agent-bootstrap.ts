import type { ContextDependencies } from '../execution/context-factory.js';
import type { VoiceDefinition } from '@plumbus/voice';
import type { VoiceProvidersConfig } from '@plumbus/voice';
import type { VoiceProviderRegistry } from '@plumbus/voice';
import type { VoiceSessionBudgetConfig } from '@plumbus/voice';
import { buildVoiceServeContext } from './voice-serve-context.js';

export interface VoiceAgentBootstrapResult {
  voices: VoiceDefinition[];
  providers: VoiceProvidersConfig;
  registry: VoiceProviderRegistry;
  createDependencies: (auth: {
    userId: string;
    tenantId?: string;
    roles: string[];
    scopes: string[];
    provider: string;
  }) => ContextDependencies;
  sessionBudget?: VoiceSessionBudgetConfig;
}

/**
 * Builds app voice runtime config for LiveKit agent child processes.
 * Child job processes import this module via PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE.
 */
export async function bootstrapVoiceAgentRuntime(): Promise<VoiceAgentBootstrapResult> {
  const ctx = await buildVoiceServeContext();
  return {
    voices: ctx.voices,
    providers: ctx.providers,
    registry: ctx.registry,
    createDependencies: (auth) => ctx.routeConfig.createDependencies(auth),
  };
}
