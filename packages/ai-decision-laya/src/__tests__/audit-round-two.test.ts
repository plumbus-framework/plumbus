import { expect, it } from 'vitest';
import { createLayaDecisionAdapter } from '../index.js';

it('[L37] rejects a response without checkpoint routing identity', async () => {
  const fetch = async () =>
    Response.json({
      model: 'laya-rl-agent',
      usage: { input_tokens: 5, output_tokens: 0 },
      answers: { p: { type: 'noul', noul: 0.8 } },
    });
  await expect(
    createLayaDecisionAdapter({ baseUrl: 'http://localhost:8080/v1', fetch }).decide({
      state: '',
      questions: { p: { type: 'probability', instructions: '?' } },
    }),
  ).rejects.toMatchObject({ kind: 'invalid_response', usage: { inputTokens: 5 } });
});
