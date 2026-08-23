import { describe, expect, it } from 'vitest';
import { resolveMcpPort } from '../commands/mcp.js';
import { resolveWorkerHealthPort } from '../commands/worker.js';

const ENV_PORT = '9090';

describe('resolveWorkerHealthPort', () => {
  it('uses the explicit --health-port flag', () => {
    expect(resolveWorkerHealthPort('8080', {})).toBe(8080);
  });

  it('falls back to PLUMBUS_WORKER_HEALTH_PORT', () => {
    expect(resolveWorkerHealthPort(undefined, { PLUMBUS_WORKER_HEALTH_PORT: ENV_PORT })).toBe(9090);
  });

  it('prefers the flag over env', () => {
    expect(resolveWorkerHealthPort('4000', { PLUMBUS_WORKER_HEALTH_PORT: ENV_PORT })).toBe(4000);
  });

  it('rejects missing values', () => {
    expect(() => resolveWorkerHealthPort(undefined, {})).toThrow(/--health-port is required/);
  });

  it('rejects out-of-range ports', () => {
    expect(() => resolveWorkerHealthPort('0', {})).toThrow(/Invalid port/);
    expect(() => resolveWorkerHealthPort('70000', {})).toThrow(/Invalid port/);
  });
});

describe('resolveMcpPort', () => {
  it('uses the explicit --port flag', () => {
    expect(resolveMcpPort('8080', {})).toBe(8080);
  });

  it('falls back to PLUMBUS_MCP_PORT', () => {
    expect(resolveMcpPort(undefined, { PLUMBUS_MCP_PORT: ENV_PORT })).toBe(9090);
  });

  it('prefers the flag over env', () => {
    expect(resolveMcpPort('4000', { PLUMBUS_MCP_PORT: ENV_PORT })).toBe(4000);
  });

  it('rejects missing values', () => {
    expect(() => resolveMcpPort(undefined, {})).toThrow(/--port is required/);
  });

  it('rejects out-of-range ports', () => {
    expect(() => resolveMcpPort('0', {})).toThrow(/Invalid port/);
    expect(() => resolveMcpPort('70000', {})).toThrow(/Invalid port/);
  });
});
