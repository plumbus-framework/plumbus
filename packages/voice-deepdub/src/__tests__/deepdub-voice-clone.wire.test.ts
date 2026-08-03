import { createProviderRegistry, createVoiceCloneProvider } from '@plumbus/voice';
import { describe, expect, it } from 'vitest';
import { DEEPDUB_TTS_REGISTRATION } from '../deepdub-tts.js';

describe('Deepdub voice cloning', () => {
  it('creates a clone via SDK addVoice and maps voice_prompt_id', async () => {
    const registry = createProviderRegistry({
      tts: { deepdub: DEEPDUB_TTS_REGISTRATION },
    });
    const clone = createVoiceCloneProvider({
      providerId: 'deepdub',
      providers: {
        providers: {
          deepdub: {
            apiKey: 'dd-key',
            options: {
              deepdubClientFactory: () => ({
                async connect() {
                  return {};
                },
                async generateToBuffer() {
                  return Buffer.from([]);
                },
                async addVoice(params: Record<string, unknown>) {
                  expect(params.gender).toBe('FEMALE');
                  expect(params.locale).toBe('he-IL');
                  expect(params.speakingStyle).toBe('Reading');
                  expect(params.text).toBe('A short passage read aloud.');
                  return { voice_prompt_id: 'vp-123' };
                },
                async listVoices() {
                  return { voicePrompts: [{ id: 'vp-123', title: 'Mine' }] };
                },
              }),
            },
          },
        },
      },
      registry,
    });

    const created = await clone.create({
      name: 'Mine',
      audio: Buffer.from('wav-bytes'),
      filename: 'sample.wav',
      gender: 'female',
      locale: 'he-IL',
      speakingStyle: 'Reading',
      text: 'A short passage read aloud.',
    });
    expect(created).toMatchObject({
      id: 'vp-123',
      providerId: 'deepdub',
      displayName: 'Mine',
      status: 'ready',
    });
  });

  it('maps the live { response: { id } } addVoice payload', async () => {
    // Verbatim body observed from POST https://restapi.deepdub.ai/api/v1/voice — the live
    // API returns no voice_prompt_id at any level, only response.id.
    const registry = createProviderRegistry({
      tts: { deepdub: DEEPDUB_TTS_REGISTRATION },
    });
    const clone = createVoiceCloneProvider({
      providerId: 'deepdub',
      providers: {
        providers: {
          deepdub: {
            apiKey: 'dd-key',
            options: {
              deepdubClientFactory: () => ({
                async connect() {
                  return {};
                },
                async generateToBuffer() {
                  return Buffer.from([]);
                },
                async addVoice(params: Record<string, unknown>) {
                  // No transcript supplied — the param must be omitted, not sent empty.
                  expect(params.text).toBeUndefined();
                  return {
                    response: {
                      id: '0218c0c3-f32f-49ff-988b-8f35394fe455',
                      title: 'probe.wav',
                      name: 'plumbus-probe-shape',
                      locale: 'he-IL',
                      text: '',
                      createdAt: '2026-07-28T12:18:28.687+00:00',
                      speakingStyle: 'Neutral',
                      gender: 'MALE',
                    },
                  };
                },
              }),
            },
          },
        },
      },
      registry,
    });

    const created = await clone.create({
      name: 'plumbus-probe-shape',
      audio: Buffer.from('wav-bytes'),
      filename: 'probe.wav',
      gender: 'male',
      locale: 'he-IL',
    });
    expect(created).toMatchObject({
      id: '0218c0c3-f32f-49ff-988b-8f35394fe455',
      providerId: 'deepdub',
      status: 'ready',
    });
  });

  it('rejects missing gender/locale', async () => {
    const registry = createProviderRegistry({
      tts: { deepdub: DEEPDUB_TTS_REGISTRATION },
    });
    const clone = createVoiceCloneProvider({
      providerId: 'deepdub',
      providers: {
        providers: {
          deepdub: {
            apiKey: 'dd-key',
            options: {
              deepdubClientFactory: () => ({
                async connect() {
                  return {};
                },
                async generateToBuffer() {
                  return Buffer.from([]);
                },
                async addVoice() {
                  return {};
                },
              }),
            },
          },
        },
      },
      registry,
    });

    await expect(
      clone.create({
        name: 'x',
        audio: Buffer.from('a'),
        filename: 'a.wav',
        locale: 'en-US',
      }),
    ).rejects.toThrow(/gender/);
  });

  it('lists voices from voicePrompts via SDK', async () => {
    const voices = await DEEPDUB_TTS_REGISTRATION.listVoices?.(
      {
        apiKey: 'dd-key',
        options: {
          deepdubClientFactory: () => ({
            async connect() {
              return {};
            },
            async generateToBuffer() {
              return Buffer.from([]);
            },
            async listVoices() {
              return {
                voicePrompts: [
                  { id: 'a', title: 'Alpha' },
                  { id: 'b', name: 'Beta' },
                ],
              };
            },
          }),
        },
      },
      undefined,
      {},
    );
    expect(voices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a', displayName: 'Alpha' }),
        expect.objectContaining({ id: 'b', displayName: 'Beta' }),
      ]),
    );
  });

  it('deletes via REST x-api-key', async () => {
    const calls: Array<{ url: string; method?: string; headers: HeadersInit }> = [];
    const registry = createProviderRegistry({
      tts: { deepdub: DEEPDUB_TTS_REGISTRATION },
    });
    const clone = createVoiceCloneProvider({
      providerId: 'deepdub',
      providers: {
        providers: {
          deepdub: {
            apiKey: 'dd-key',
            options: {
              fetch: async (url: string, init?: RequestInit) => {
                calls.push({
                  url,
                  method: init?.method,
                  headers: init?.headers ?? {},
                });
                return {
                  ok: true,
                  status: 200,
                  async json() {
                    return { success: true };
                  },
                };
              },
            },
          },
        },
      },
      registry,
    });

    await clone.delete('vp-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/voice/vp-1');
    expect(calls[0]?.method).toBe('DELETE');
    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers['x-api-key'] ?? headers['X-Api-Key']).toBe('dd-key');
  });

  it('synthesizes instant voiceReference over HTTP', async () => {
    const audio = await DEEPDUB_TTS_REGISTRATION.clone?.synthesizeWithVoiceReference?.(
      {
        apiKey: 'dd-key',
        options: {
          deepdubClientFactory: (_key: string, opts: { protocol: string }) => {
            expect(opts.protocol).toBe('http');
            return {
              async connect() {
                return {};
              },
              async generateToBuffer(text: string, params: Record<string, unknown>) {
                expect(text).toBe('hi');
                expect(Buffer.isBuffer(params.voiceReference)).toBe(true);
                return Buffer.from([1, 2, 3]);
              },
            };
          },
        },
      },
      {
        text: 'hi',
        audio: Buffer.from('ref'),
        filename: 'r.wav',
        locale: 'en-US',
      },
    );
    expect(Buffer.from(audio ?? [])).toEqual(Buffer.from([1, 2, 3]));
  });
});
