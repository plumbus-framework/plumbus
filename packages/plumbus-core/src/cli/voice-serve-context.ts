import { buildMcpServeContext, type McpServeContext } from './mcp-serve-context.js';

export interface VoiceServeContext extends McpServeContext {
  voices: Awaited<ReturnType<typeof import('@plumbus/voice').discoverVoices>>;
  providers: ReturnType<typeof import('@plumbus/voice').resolveVoiceProvidersFromEnv>;
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
  const providers = voicePkg.resolveVoiceProvidersFromEnv();

  return {
    ...base,
    voices,
    providers,
  };
}
