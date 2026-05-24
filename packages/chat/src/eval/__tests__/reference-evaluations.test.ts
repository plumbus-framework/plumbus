import { describe, expect, it } from '@plumbus/core/testing';
import { createTestContext, mockAI } from '@plumbus/core/testing';
import { createSession } from '../../session/service.js';
import { runChatEvaluation } from '../run-evaluation.js';
import {
  actionConfirmationEval,
  audienceFilterEval,
  scopeRefusalEval,
} from '../__fixtures__/reference-evaluations.js';

describe('reference chat evaluations', () => {
  it('audienceFilterEval passes offline', async () => {
    const ctx = createTestContext({
      auth: { roles: ['user'] },
      ai: mockAI({
        generate: {
          inScope: true,
          answer: 'ok',
          refusalReason: null,
          citedSources: [],
          requestedAction: null,
        },
      }),
    });
    const session = await createSession(ctx, {
      chatName: audienceFilterEval.chat.name,
      userId: 'u1',
      audience: 'user',
      locale: 'en',
    });
    const results = await runChatEvaluation(audienceFilterEval, ctx, {
      sessionId: session.id,
      audience: 'user',
      locale: 'en',
    });
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('scopeRefusalEval passes offline', async () => {
    const ctx = createTestContext({
      ai: mockAI({
        generate: {
          inScope: false,
          answer: '',
          refusalReason: 'off_topic',
          citedSources: [],
          requestedAction: null,
        },
      }),
    });
    const session = await createSession(ctx, {
      chatName: scopeRefusalEval.chat.name,
      userId: 'u1',
      audience: 'user',
      locale: 'en',
    });
    const results = await runChatEvaluation(scopeRefusalEval, ctx, {
      sessionId: session.id,
      audience: 'user',
      locale: 'en',
    });
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('actionConfirmationEval passes offline', async () => {
    const ctx = createTestContext({
      ai: mockAI({
        generate: {
          inScope: true,
          answer: 'done',
          refusalReason: null,
          citedSources: [],
          requestedAction: null,
        },
      }),
    });
    const session = await createSession(ctx, {
      chatName: actionConfirmationEval.chat.name,
      userId: 'u1',
      audience: 'user',
      locale: 'en',
    });
    const results = await runChatEvaluation(actionConfirmationEval, ctx, {
      sessionId: session.id,
      audience: 'user',
      locale: 'en',
    });
    expect(results.every((r) => r.passed)).toBe(true);
  });
});
