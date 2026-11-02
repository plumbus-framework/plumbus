/** Load only voices and provider registrations for the dispatch parent. */
import { loadVoiceSession as loadVoicePackage } from './load-voice-session.js';

export async function loadVoiceWorkerDefinitions() {
  const voicePkg = await loadVoicePackage();
  const appRoot = process.env.PLUMBUS_VOICE_APP_ROOT ?? process.cwd();
  const javascriptOnly = process.env.PLUMBUS_VOICE_JAVASCRIPT_ONLY === 'true';
  const voices = await voicePkg.discoverVoices({ appRoot, javascriptOnly });
  const builtins = voicePkg.resolveVoiceProvidersFromEnv();
  const appVoice = await voicePkg.loadAppVoiceRegistry({ appRoot, javascriptOnly });

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
    voices,
    registry: appVoice.registry,
    providers: { providers: { ...builtins.providers, ...(appVoice.providers?.providers ?? {}) } },
  };
}
