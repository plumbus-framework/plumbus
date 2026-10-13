import type { ExecutionContext } from '@plumbus/core';
import { describe, expect, it, vi } from 'vitest';
import { createFileTranscriptionRuntime, recordFileTranscriptionCost } from '../index.js';
import type { FileTranscriptionProvider } from '../types.js';

function context() {
  return {
    ai: {
      checkProviderCostBudget: vi.fn(),
      recordProviderCost: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Pick<ExecutionContext, 'ai' | 'signal'>;
}
function runtime() {
  const provider = {
    upload: vi
      .fn()
      .mockResolvedValue({ state: 'uploaded', fileId: 'file', uploadReference: 'reference' }),
    submit: vi.fn().mockResolvedValue({ state: 'unknown', reason: 'outcome_unknown' }),
    getJob: vi.fn().mockResolvedValue(null),
    deleteJob: vi.fn().mockResolvedValue({ state: 'pending' }),
  } as unknown as FileTranscriptionProvider;
  return {
    provider,
    runtime: createFileTranscriptionRuntime({
      registration: { id: 'fake', create: () => provider },
      credentials: {},
      config: { model: 'test', region: 'local', maxInputBytes: 100, maxOutputBytes: 100 },
    }),
  };
}
const input = {
  bytes: new Uint8Array([1]),
  byteLength: 1,
  contentType: 'video/mp4',
  uploadReference: 'opaque-reference',
};

describe('file transcription runtime', () => {
  it('checks the invoking context budget before every external submission', async () => {
    const ctx = context();
    const value = runtime();
    await value.runtime.upload(ctx, input, { estimatedCostUsd: 0.03 });
    await value.runtime.submit(
      ctx,
      { fileId: 'file', clientReference: 'ref' },
      { estimatedCostUsd: 0.03 },
    );
    expect(ctx.ai.checkProviderCostBudget).toHaveBeenCalledTimes(2);
    expect(ctx.ai.checkProviderCostBudget).toHaveBeenCalledWith({ estimatedCostUsd: 0.03 });
    expect(value.provider.submit).toHaveBeenCalledTimes(1);
  });
  it.each([
    undefined,
    null,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('refuses unknown/invalid admission %s without invoking provider', async (estimatedCostUsd) => {
    const value = runtime();
    await expect(
      value.runtime.upload(context(), input, { estimatedCostUsd: estimatedCostUsd as number }),
    ).rejects.toThrow('known admission pricing');
    expect(value.provider.upload).not.toHaveBeenCalled();
  });
  it('preserves explicit free pricing and honors budget denial', async () => {
    const value = runtime();
    const ctx = context();
    await value.runtime.upload(ctx, input, { estimatedCostUsd: 0 });
    vi.mocked(ctx.ai.checkProviderCostBudget).mockImplementation(() => {
      throw new Error('budget denied');
    });
    await expect(
      value.runtime.submit(
        ctx,
        { fileId: 'file', clientReference: 'ref' },
        { estimatedCostUsd: 1 },
      ),
    ).rejects.toThrow('budget denied');
    expect(value.provider.submit).not.toHaveBeenCalled();
  });
  it('permits recovery/deletion when new work budget is exhausted', async () => {
    const value = runtime();
    const ctx = context();
    vi.mocked(ctx.ai.checkProviderCostBudget).mockImplementation(() => {
      throw new Error('budget denied');
    });
    expect(await value.runtime.deleteJob(ctx, { jobId: 'job' })).toEqual({ state: 'pending' });
    expect(ctx.ai.checkProviderCostBudget).not.toHaveBeenCalled();
  });
  it('joins invoking-flow and explicit cancellation signals', async () => {
    const value = runtime();
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    await value.runtime.getJob(ctx, { jobId: 'job' });
    const signal = vi.mocked(value.provider.getJob).mock.calls[0]?.[1]?.signal;
    controller.abort();
    expect(signal?.aborted).toBe(true);
    await expect(value.runtime.getJob(ctx, { jobId: 'job' })).rejects.toThrow();
    expect(value.provider.getJob).toHaveBeenCalledTimes(1);
  });
  it('rejects unbounded configuration before registration', () => {
    const create = vi.fn();
    expect(() =>
      createFileTranscriptionRuntime({
        registration: { id: 'fake', create },
        credentials: {},
        config: { model: 'test', region: 'local', maxInputBytes: Infinity, maxOutputBytes: 100 },
      }),
    ).toThrow('configuration');
    expect(create).not.toHaveBeenCalled();
  });
});

const measured = {
  state: 'known' as const,
  audioSeconds: 12.3,
  inputAudioTokens: 1200,
  inputTextTokens: 20,
  outputTextTokens: 40,
  costUsd: null,
};
const price = {
  inputAudioUsdPerMillion: 1.5,
  inputTextUsdPerMillion: 3.5,
  outputTextUsdPerMillion: 3.5,
};
describe('file transcription cost', () => {
  it('records actual aggregate tokens and duration with the invoking tenant ledger', async () => {
    const ctx = context();
    const result = await recordFileTranscriptionCost(ctx, {
      model: 'stt',
      provider: 'fake',
      usage: measured,
      pricing: price,
      latencyMs: 3,
      costContext: { projectId: 'tenant-project', operationName: 'media.transcribe' },
    });
    expect(result.cost).toBeCloseTo(0.00201);
    expect(result.usage).toEqual(measured);
    expect(ctx.ai.recordProviderCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'transcribe',
        usage: { inputTokens: 1220, outputTokens: 40, totalTokens: 1260 },
        mediaUsage: { audioInputSeconds: 12.3 },
        cost: result.cost,
      }),
      { projectId: 'tenant-project', operationName: 'media.transcribe' },
    );
    expect(vi.mocked(ctx.ai.recordProviderCost).mock.calls[0]?.[0]).not.toHaveProperty(
      'promptName',
    );
  });
  it('prefers actual provider cost including a measured zero', async () => {
    const result = await recordFileTranscriptionCost(context(), {
      model: 'stt',
      provider: 'fake',
      usage: { ...measured, costUsd: 0 },
      pricing: price,
      latencyMs: 3,
    });
    expect(result.cost).toBe(0);
  });
  it('retains unknown usage/cost rather than inventing free spend', async () => {
    const ctx = context();
    const result = await recordFileTranscriptionCost(ctx, {
      model: 'stt',
      provider: 'fake',
      usage: { state: 'unknown', reason: 'not_found' },
      pricing: price,
      latencyMs: 3,
    });
    expect(result.cost).toBeNull();
    expect(ctx.ai.recordProviderCost).toHaveBeenCalledWith(
      expect.objectContaining({ cost: null, status: 'incomplete', mediaUsage: undefined }),
      undefined,
    );
  });
  it('preserves measured token totals when pricing is unknown', async () => {
    const ctx = context();
    const result = await recordFileTranscriptionCost(ctx, {
      model: 'stt',
      provider: 'fake',
      usage: measured,
      latencyMs: 3,
    });
    expect(result.cost).toBeNull();
    expect(ctx.ai.recordProviderCost).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { inputTokens: 1220, outputTokens: 40, totalTokens: 1260 },
      }),
      undefined,
    );
  });
  it('rejects malformed usage before ledger writes', async () => {
    const ctx = context();
    await expect(
      recordFileTranscriptionCost(ctx, {
        model: 'stt',
        provider: 'fake',
        usage: { ...measured, inputAudioTokens: -1 },
        latencyMs: 3,
      }),
    ).rejects.toThrow('Invalid measured');
    expect(ctx.ai.recordProviderCost).not.toHaveBeenCalled();
  });
});
