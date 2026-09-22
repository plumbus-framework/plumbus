import { buildMcpServeContext, type McpServeContext } from './mcp-serve-context.js';

export interface VoiceServeContext extends McpServeContext {
  voices: Awaited<ReturnType<typeof import('@plumbus/voice').discoverVoices>>;
  providers: ReturnType<typeof import('@plumbus/voice').resolveVoiceProvidersFromEnv>;
  registry: import('@plumbus/voice').VoiceProviderRegistry;
}

async function loadVoicePackage(): Promise<typeof import('@plumbus/voice')> {
  try {
    return await import('@plumbus/voice');
  } catch {
    console.error('');
    console.error('Voice runtime not installed.');
    console.error('Run: pnpm add @plumbus/voice');
    console.error('');
    process.exit(1);
  }
}

export async function buildVoiceServeContext(): Promise<VoiceServeContext> {
  const voicePkg = await loadVoicePackage();
  const base = await buildMcpServeContext();
  const voices = await voicePkg.discoverVoices();
  const builtins = voicePkg.resolveVoiceProvidersFromEnv();
  const appVoice = await voicePkg.loadAppVoiceRegistry();

  if (!appVoice) {
    console.error('');
    console.error('Missing app/voice/registry.ts');
    console.error(
      'Export voiceProviderRegistry from createProviderRegistry({ ...*_REGISTRATION }) for the providers your voices use.',
    );
    console.error('Optionally export voiceProviders for credentials.');
    console.error('');
    process.exit(1);
  }

  return {
    ...base,
    voices,
    registry: appVoice.registry,
    providers: {
      providers: {
        ...builtins.providers,
        ...(appVoice.providers?.providers ?? {}),
      },
    },
  };
}
