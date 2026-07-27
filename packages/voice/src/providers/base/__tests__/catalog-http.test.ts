import { describe, expect, it, vi } from 'vitest';
import { fetchCatalogJson, normalizeVoiceList } from '../catalog-http.js';

describe('catalog-http', () => {
  it('passes request body through to the catalog fetcher', async () => {
    const fetcher = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify({ voice_type: 'all' }));
      return {
        ok: true,
        status: 200,
        async json() {
          return { system_voice: [] };
        },
      };
    });

    await fetchCatalogJson(
      { apiKey: 'test-key' },
      fetcher,
      'https://api.example.test/v1/get_voice',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice_type: 'all' }),
      },
    );

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('maps voice_name to displayName', () => {
    const voices = normalizeVoiceList([{ voice_id: 'id-1', voice_name: 'Friendly Narrator' }]);

    expect(voices).toEqual([
      expect.objectContaining({
        id: 'id-1',
        displayName: 'Friendly Narrator',
      }),
    ]);
  });
});
