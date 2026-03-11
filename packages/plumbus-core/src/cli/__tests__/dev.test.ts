import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDev } from '../commands/dev.js';

// ── Tests ──

describe('CLI dev command', () => {
  beforeEach(() => {
    // CLI utils use console.log for info/warn and console.error for error
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('runDev', () => {
    it('returns config, validation, and serverUrl', () => {
      const result = runDev({});
      expect(result).toHaveProperty('config');
      expect(result).toHaveProperty('validation');
      expect(result).toHaveProperty('serverUrl');
    });

    it('defaults to port 3000 and host localhost', () => {
      const result = runDev({});
      expect(result.serverUrl).toBe('http://localhost:3000');
    });

    it('uses custom port from options', () => {
      const result = runDev({ port: '4000' });
      expect(result.serverUrl).toBe('http://localhost:4000');
    });

    it('uses custom host from options', () => {
      const result = runDev({ host: '0.0.0.0' });
      expect(result.serverUrl).toBe('http://0.0.0.0:3000');
    });

    it('uses both custom port and host', () => {
      const result = runDev({ port: '8080', host: '127.0.0.1' });
      expect(result.serverUrl).toBe('http://127.0.0.1:8080');
    });

    it('loads config with development environment', () => {
      const result = runDev({});
      expect(result.config.environment).toBe('development');
    });

    it('config has development database defaults', () => {
      const result = runDev({});
      expect(result.config.database.host).toBe('localhost');
      expect(result.config.database.database).toBe('plumbus_dev');
    });

    it('validation is valid for development defaults', () => {
      const result = runDev({});
      expect(result.validation.valid).toBe(true);
      expect(result.validation.errors).toHaveLength(0);
    });

    it('prints info messages for non-JSON mode', () => {
      runDev({});
      expect(console.log).toHaveBeenCalled();
    });

    it('suppresses info output in JSON mode', () => {
      runDev({ json: true });
      expect(console.log).not.toHaveBeenCalled();
    });

    it('prints server URL info', () => {
      runDev({});
      const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((msg: string) => msg.includes('Server URL'))).toBe(true);
    });

    it('prints database info', () => {
      runDev({});
      const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((msg: string) => msg.includes('Database'))).toBe(true);
    });

    it('prints queue info', () => {
      runDev({});
      const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((msg: string) => msg.includes('Queue'))).toBe(true);
    });

    it('warns when AI provider is not configured', () => {
      runDev({});
      // warn() uses console.log with ⚠ prefix
      const calls = (console.log as any).mock.calls.map((c: any[]) => c[0]);
      expect(calls.some((msg: string) => msg.includes('AI provider not configured'))).toBe(true);
    });
  });
});
