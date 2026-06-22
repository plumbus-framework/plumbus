import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../../define/defineVoice.js';

const providers = {
  providers: {
    livekit: {
      url: 'wss://livekit.example.test',
      apiKey: 'lk-key',
      apiSecret: 'lk-secret',
    },
    soniox: { apiKey: 'soniox-key' },
    deepdub: { apiKey: 'deepdub-key' },
  },
};

const sampleVoice = defineVoice({
  name: 'interviewer',
  access: { roles: ['user'] },
  transport: { provider: 'livekit', mode: 'continuous' },
  stt: { provider: 'soniox', languages: ['he'] },
  tts: { provider: 'deepdub', voiceId: 'voice-1', locale: 'he-IL' },
  brain: {
    async run() {
      return { text: 'ok' };
    },
  },
});

export async function bootstrapVoiceAgentRuntime() {
  return {
    voices: [sampleVoice],
    providers,
    createDependencies: () => createTestContext(),
  };
}
