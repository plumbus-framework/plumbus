import { describe, expect, it } from 'vitest';
import { resolveAuthTransport } from '../commands/ui.js';

describe('resolveAuthTransport', () => {
  it('accepts session and bearer', () => {
    expect(resolveAuthTransport('session')).toBe('session');
    expect(resolveAuthTransport('bearer')).toBe('bearer');
    expect(resolveAuthTransport(undefined)).toBeUndefined();
  });

  it('rejects invalid values', () => {
    expect(() => resolveAuthTransport('jwt')).toThrow(/Invalid --auth-transport/);
  });
});
