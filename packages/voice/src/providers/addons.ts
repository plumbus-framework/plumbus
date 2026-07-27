/**
 * Static install-hint map for known `@plumbus/voice-*` add-on packages.
 * Add-ons are NOT auto-loaded — apps must pass `*_REGISTRATION` into
 * `createProviderRegistry({ stt/tts/transport })`.
 */

export const VOICE_ADDON_PACKAGES = {
  deepdub: {
    kind: 'tts',
    pkg: '@plumbus/voice-deepdub',
    exportName: 'DEEPDUB_TTS_REGISTRATION',
  },
  soniox: {
    kind: 'stt',
    pkg: '@plumbus/voice-soniox',
    exportName: 'SONIOX_STT_REGISTRATION',
  },
  elevenlabs: {
    kind: 'tts',
    pkg: '@plumbus/voice-elevenlabs',
    exportName: 'ELEVENLABS_TTS_REGISTRATION',
  },
  minimax: {
    kind: 'tts',
    pkg: '@plumbus/voice-minimax',
    exportName: 'MINIMAX_TTS_REGISTRATION',
  },
  livekit: {
    kind: 'transport',
    pkg: '@plumbus/voice-livekit',
    exportName: 'LIVEKIT_TRANSPORT_REGISTRATION',
  },
} as const;

export function voiceAddonPackageFor(providerId: string): string | undefined {
  return VOICE_ADDON_PACKAGES[providerId as keyof typeof VOICE_ADDON_PACKAGES]?.pkg;
}

export function voiceAddonMissingHint(providerId: string):
  | {
      installPackage: string;
      message: string;
    }
  | undefined {
  const installPackage = voiceAddonPackageFor(providerId);
  if (!installPackage) {
    return undefined;
  }
  return {
    installPackage,
    message: `Voice provider "${providerId}" requires ${installPackage}. Install it and pass its *_REGISTRATION to createProviderRegistry(). Run: pnpm add ${installPackage}`,
  };
}
