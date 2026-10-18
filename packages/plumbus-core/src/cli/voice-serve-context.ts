import { loadVoiceWorkerDefinitions } from './voice-worker-definitions.js';
import { loadAppConfig } from '../config/index.js';
import { buildResourceContext, type ResourceContext } from '../runtime/resource-context.js';
import { loadVoiceRuntime } from '../runtime/voice-runtime.js';

export interface VoiceServeContext extends ResourceContext {
  voices: Awaited<ReturnType<typeof import('@plumbus/voice').discoverVoices>>;
  providers: ReturnType<typeof import('@plumbus/voice').resolveVoiceProvidersFromEnv>;
  registry: import('@plumbus/voice').VoiceProviderRegistry;
}

export async function buildVoiceServeContext(): Promise<VoiceServeContext> {
  const definitions = await loadVoiceWorkerDefinitions();
  const appRoot = process.env.PLUMBUS_VOICE_APP_ROOT ?? process.cwd();
  const javascriptOnly = process.env.PLUMBUS_VOICE_JAVASCRIPT_ONLY === 'true';
  const runtime = await loadVoiceRuntime(appRoot, { javascriptOnly });
  const base = runtime
    ? await buildResourceContext({
        config: await loadAppConfig({}, appRoot, { javascriptOnly }),
        resources: {
          flows: [],
          translations: [],
          schemas: {},
          ...runtime.resources,
        },
        extensions: {
          ...runtime.extensions,
          ...(runtime.extensions.decisions
            ? {
                decisions: {
                  ...runtime.extensions.decisions,
                  definitions: [
                    ...(runtime.extensions.decisions.definitions ?? []),
                    ...(runtime.resources.decisions ?? []),
                  ],
                },
              }
            : {}),
        },
        // This context is used by workers, not an HTTP/MCP endpoint. Identity
        // comes from the existing voice transport. Never accept bearer tokens here.
        authAdapter: { authenticate: async () => null },
        component: 'voice-capability',
        securityEntities: runtime.resources.securityEntities,
        openQueues: false,
        enableFlows: (runtime.resources.flows?.length ?? 0) > 0,
      })
    : await (await import('./mcp-serve-context.js')).buildMcpServeContext();

  return { ...base, ...definitions };
}
