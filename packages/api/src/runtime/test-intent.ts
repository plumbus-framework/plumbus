import { readFile } from 'node:fs/promises';
import type { ApiTestConfig, ApiTestMode, CapabilityContract } from '@plumbus/core';
import { FixturePathEscapeError, resolveContainedFixturePath } from './fixture-path.js';
import type { ApiSuccessEnvelope } from './envelope.js';

export const TEST_INTENT_HEADER = 'x-plumbus-intent';
export const TEST_MODE_HEADER = 'x-plumbus-test-mode';

export function isTestIntent(
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, unknown>,
  allowQueryIntent: boolean,
): boolean {
  const headerVal = headers[TEST_INTENT_HEADER];
  if (typeof headerVal === 'string' && headerVal.toLowerCase() === 'test') {
    return true;
  }
  if (allowQueryIntent && query.intent === 'test') {
    return true;
  }
  return false;
}

export function resolveTestMode(
  test: ApiTestConfig | undefined,
  headers: Record<string, string | string[] | undefined>,
): ApiTestMode | undefined {
  if (!test?.enabled) {
    return undefined;
  }

  const headerMode = headers[TEST_MODE_HEADER];
  if (typeof headerMode === 'string' && test.modes.includes(headerMode as ApiTestMode)) {
    return headerMode as ApiTestMode;
  }

  if (test.defaultMode && test.modes.includes(test.defaultMode)) {
    return test.defaultMode;
  }

  return test.modes[0];
}

export class FixtureSchemaMismatchError extends Error {
  constructor() {
    super('Test fixture does not match output schema');
    this.name = 'FixtureSchemaMismatchError';
  }
}

export class FixtureReadError extends Error {
  readonly causeCode?: string;

  constructor(cause?: unknown) {
    const code =
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      typeof (cause as { code: unknown }).code === 'string'
        ? (cause as { code: string }).code
        : undefined;
    super(
      code === 'ENOENT'
        ? 'Test fixture not found'
        : cause instanceof FixturePathEscapeError
          ? cause.message
          : 'Failed to read test fixture',
    );
    this.name = 'FixtureReadError';
    this.causeCode = code;
  }
}

export async function runSafeReply(
  cap: CapabilityContract,
  appRoot: string,
  fixturePath?: string,
): Promise<{ data: unknown; source: string; scenario?: string }> {
  const fixture = fixturePath ?? cap.api?.test?.safeReply?.fixture;
  if (!fixture) {
    throw new FixtureReadError();
  }

  let resolvedPath: string;
  try {
    resolvedPath = resolveContainedFixturePath(appRoot, fixture);
  } catch (err) {
    throw new FixtureReadError(err);
  }

  let raw: string;
  try {
    raw = await readFile(resolvedPath, 'utf8');
  } catch (err) {
    throw new FixtureReadError(err);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    throw new FixtureReadError();
  }

  const parsed = cap.output.safeParse(data);
  if (!parsed.success) {
    throw new FixtureSchemaMismatchError();
  }

  return {
    data: parsed.data,
    source: 'fixture',
    scenario: 'safe-reply',
  };
}

export function buildTestEnvelope<T>(
  data: T,
  mode: ApiTestMode,
  requestId: string,
  apiVersion: string,
  testMeta: { source?: string; scenario?: string },
): ApiSuccessEnvelope<T> {
  return {
    ok: true,
    intent: 'test',
    mode,
    data,
    test: {
      sideEffects: 'disabled',
      source: testMeta.source,
      scenario: testMeta.scenario,
      contractVersion: apiVersion,
    },
    meta: { requestId, apiVersion },
  };
}
