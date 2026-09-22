import { createProviderRegistry, createVoiceCloneProvider } from '@plumbus/voice';
import { describe, expect, it } from 'vitest';
import { SONIOX_TTS_REGISTRATION } from '../soniox-tts.js';

describe('Soniox voice cloning', () => {
  it('creates, waits until ready, and deletes via tts.voices', async () => {
    let status: 'processing' | 'ready' = 'processing';
    const deleted: string[] = [];
    const registry = createProviderRegistry({
      tts: { soniox: SONIOX_TTS_REGISTRATION },
    });
    const clone = createVoiceCloneProvider({
      providerId: 'soniox',
      providers: {
        providers: {
          soniox: {
            apiKey: 'sx-key',
            options: {
              sonioxClientFactory: () => ({
                tts: {
                  generateStream: async function* () {},
                  voices: {
                    async create(options: { name: string }) {
                      return {
                        id: '11111111-1111-1111-1111-111111111111',
                        name: options.name,
                        models: [{ model: 'tts-rt-v1', status: 'processing' }],
                        isReady() {
                          return status === 'ready';
                        },
                      };
                    },
                    async get(id: string) {
                      return {
                        id,
                        name: 'clone',
                        models: [{ model: 'tts-rt-v1', status }],
                        isReady(model: string) {
                          return model === 'tts-rt-v1' && status === 'ready';
                        },
                      };
                    },
                    async list() {
                      return { voices: [], next_page_cursor: null };
                    },
                    async delete(id: string) {
                      deleted.push(id);
                    },
                    async recompute(id: string) {
                      return {
                        id,
                        name: 'clone',
                        models: [{ model: 'tts-rt-v1', status: 'ready' }],
                        isReady() {
                          return true;
                        },
                      };
                    },
                  },
                },
              }),
            },
          },
        },
      },
      registry,
    });

    const created = await clone.create({
      name: 'Narrator',
      audio: Buffer.from('clip'),
      filename: 'clip.wav',
    });
    expect(created.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(created.status).toBe('processing');

    setTimeout(() => {
      status = 'ready';
    }, 20);

    const ready = await clone.waitUntilReady(created.id, {
      model: 'tts-rt-v1',
      pollIntervalMs: 10,
      timeoutMs: 2000,
    });
    expect(ready.status).toBe('ready');

    await clone.delete(created.id);
    expect(deleted).toEqual([created.id]);
  });

  it('throws when instant reference is requested', async () => {
    expect(SONIOX_TTS_REGISTRATION.clone?.synthesizeWithVoiceReference).toBeUndefined();
    expect(SONIOX_TTS_REGISTRATION.clone?.capabilities.supportsInstantReference).toBe(false);
  });
});
