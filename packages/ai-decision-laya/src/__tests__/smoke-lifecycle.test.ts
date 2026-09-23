import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { runCommand } = await import(
  new URL('../../../../examples/ai-decision-smoke/lib/control.mjs', import.meta.url).href
);
const { repoRoot } = await import(
  new URL('../../../../examples/ai-decision-smoke/lib/config.mjs', import.meta.url).href
);

function setup({ exists = false, running = false, foreign = false } = {}) {
  const docker = vi.fn(async (args: string[]) => {
    if (args[0] === 'inspect' && args[2] === '{{json .Config.Labels}}')
      return exists
        ? JSON.stringify({
            'com.plumbus.example': 'ai-decision-smoke',
            'com.plumbus.workspace': foreign ? '/different/workspace' : repoRoot.replace(/\/$/, ''),
          })
        : null;
    if (args[0] === 'inspect') return String(running);
    return 'ok';
  });
  const config = {
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'english',
    port: 8080,
    envFile: '/synthetic/example.env',
  };
  const deps = {
    docker,
    loadConfig: async () => config,
    ensureEnvironment: async () => config,
    waitForReady: vi.fn(async () => {}),
    runSmoke: vi.fn(async () => ({ results: [], checks: ['fixture'] })),
  };
  return { deps, commands: () => docker.mock.calls.map(([args]) => args[0]) };
}
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'table').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('smoke server lifecycle without loading a model', () => {
  it('stops a server created by a one-off run and retains its container/cache', async () => {
    const { deps, commands } = setup();
    await runCommand('run', undefined, deps);
    expect(commands()).toEqual(['inspect', 'build', 'run', 'stop']);
    expect(deps.runSmoke).toHaveBeenCalledOnce();
  });
  it('stops a newly started server when inference fails', async () => {
    const { deps, commands } = setup();
    deps.runSmoke.mockRejectedValueOnce(new Error('inference failed'));
    await expect(runCommand('run', undefined, deps)).rejects.toThrow('inference failed');
    expect(commands().at(-1)).toBe('stop');
  });
  it('stops a newly started server when readiness fails', async () => {
    const { deps, commands } = setup();
    deps.waitForReady.mockRejectedValueOnce(new Error('startup failed'));
    await expect(runCommand('run', undefined, deps)).rejects.toThrow('startup failed');
    expect(commands().at(-1)).toBe('stop');
    expect(deps.runSmoke).not.toHaveBeenCalled();
  });
  it('stops an existing stopped container that this run started', async () => {
    const { deps, commands } = setup({ exists: true });
    await runCommand('run', undefined, deps);
    expect(commands()).toEqual(['inspect', 'inspect', 'start', 'stop']);
  });
  it('preserves a server already running before this invocation', async () => {
    const { deps, commands } = setup({ exists: true, running: true });
    await runCommand('run', undefined, deps);
    expect(commands()).toEqual(['inspect', 'inspect']);
    expect(deps.runSmoke).toHaveBeenCalledOnce();
  });
  it('keeps an explicitly started server for subsequent smoke requests', async () => {
    const { deps, commands } = setup();
    await runCommand('start', undefined, deps);
    expect(commands()).toEqual(['inspect', 'build', 'run']);
    expect(deps.runSmoke).not.toHaveBeenCalled();
    await runCommand('smoke', undefined, deps);
    expect(commands()).toEqual(['inspect', 'build', 'run']);
    expect(deps.runSmoke).toHaveBeenCalledOnce();
  });
  it('refuses to change another workspace’s container', async () => {
    const { deps, commands } = setup({ exists: true, running: true, foreign: true });
    await expect(runCommand('run', undefined, deps)).rejects.toThrow('another setup');
    expect(commands()).toEqual(['inspect']);
  });
});
