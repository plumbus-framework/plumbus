import { describe, expect, it } from 'vitest';
import {
  needsJobQueuePublish,
  needsWorkerPool,
  resolveRuntimeRole,
  shouldStartApiServer,
  shouldStartWorkerPool,
} from '../bootstrap.js';

describe('resolveRuntimeRole', () => {
  it('defaults dev and start to all', () => {
    expect(resolveRuntimeRole('dev', {})).toBe('all');
    expect(resolveRuntimeRole('start', {})).toBe('all');
  });

  it('defaults worker command to worker', () => {
    expect(resolveRuntimeRole('worker', {})).toBe('worker');
  });

  it('respects PLUMBUS_RUNTIME_ROLE', () => {
    expect(resolveRuntimeRole('start', { PLUMBUS_RUNTIME_ROLE: 'api' })).toBe('api');
    expect(resolveRuntimeRole('worker', { PLUMBUS_RUNTIME_ROLE: 'all' })).toBe('all');
  });
});

describe('shouldStartWorkerPool / shouldStartApiServer', () => {
  it('api role skips workers but keeps API', () => {
    expect(shouldStartWorkerPool('api')).toBe(false);
    expect(shouldStartApiServer('api')).toBe(true);
  });

  it('worker role skips API', () => {
    expect(shouldStartApiServer('worker')).toBe(false);
    expect(shouldStartWorkerPool('worker')).toBe(true);
  });
});

describe('needsWorkerPool', () => {
  it('returns true when job capabilities exist', () => {
    expect(
      needsWorkerPool({
        capabilities: [{ kind: 'job', name: 'x', domain: 'd' } as never],
        entities: [],
        flows: [],
        events: [],
        prompts: [],
        translations: [],
      }),
    ).toBe(true);
  });

  it('returns false for empty resources', () => {
    expect(
      needsWorkerPool({
        capabilities: [],
        entities: [],
        flows: [],
        events: [],
        prompts: [],
        translations: [],
      }),
    ).toBe(false);
  });
});

describe('needsJobQueuePublish', () => {
  it('returns true when job capabilities exist', () => {
    expect(
      needsJobQueuePublish({
        capabilities: [{ kind: 'job', name: 'x', domain: 'd' } as never],
        entities: [],
        flows: [],
        events: [],
        prompts: [],
        translations: [],
      }),
    ).toBe(true);
  });

  it('returns false without job capabilities', () => {
    expect(
      needsJobQueuePublish({
        capabilities: [{ kind: 'action', name: 'x', domain: 'd' } as never],
        entities: [],
        flows: [],
        events: [],
        prompts: [],
        translations: [],
      }),
    ).toBe(false);
  });
});
