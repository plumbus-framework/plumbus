import { describe, expect, it } from 'vitest';
import { findVitestConfigPath, isE2EConfigPath, normalizeVitestArgs } from '../commands/test.js';

describe('CLI test command helpers', () => {
  it('defaults to single-run mode when only options are provided', () => {
    expect(normalizeVitestArgs(['--config', 'vitest.config.ts'])).toEqual([
      'run',
      '--config',
      'vitest.config.ts',
    ]);
  });

  it('detects e2e configs and adds the runner config loader', () => {
    expect(normalizeVitestArgs(['--config', 'frontend/e2e/vitest.config.e2e.ts'])).toEqual([
      'run',
      '--config',
      'frontend/e2e/vitest.config.e2e.ts',
      '--configLoader',
      'runner',
    ]);
  });

  it('preserves an explicit vitest subcommand', () => {
    expect(normalizeVitestArgs(['watch', '--config', 'vitest.config.ts'])).toEqual([
      'watch',
      '--config',
      'vitest.config.ts',
    ]);
  });

  it('does not duplicate a provided config loader', () => {
    expect(
      normalizeVitestArgs([
        '--config',
        'frontend/e2e/vitest.config.e2e.ts',
        '--configLoader',
        'bundle',
      ]),
    ).toEqual(['run', '--config', 'frontend/e2e/vitest.config.e2e.ts', '--configLoader', 'bundle']);
  });

  it('supports equals-style config flags', () => {
    expect(findVitestConfigPath(['run', '--config=frontend/e2e/vitest.config.e2e.ts'])).toBe(
      'frontend/e2e/vitest.config.e2e.ts',
    );
    expect(isE2EConfigPath('vitest.config.e2e.ts')).toBe(true);
  });
});
