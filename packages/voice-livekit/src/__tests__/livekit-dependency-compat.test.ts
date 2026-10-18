import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `@livekit/agents` and this package must share ONE `@livekit/rtc-node`: the
 * worker hands agents' room objects to our audio code, and two copies of the
 * native bindings do not interoperate. Upgrade both pins together: agents 1.9.3
 * adds the supported inference-preload opt-out and requires rtc-node 1.1.
 */
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

/** The package root a module resolves to, as seen from `fromDir`. */
function packageRoot(fromDir: string, name: string): string {
  const entry = createRequire(join(fromDir, 'package.json')).resolve(name);
  let dir = dirname(entry);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === name) return realpathSync(dir);
    } catch {
      // not a package root; keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package root for ${name} above ${entry}`);
    dir = parent;
  }
}

function version(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string })
    .version;
}

describe('LiveKit dependency compatibility', () => {
  it('pins @livekit/agents to a release that works with rtc-node 1.1', () => {
    expect(manifest.dependencies['@livekit/agents']).toBe('1.9.3');
    expect(manifest.dependencies['@livekit/rtc-node']).toBe('1.1.0');
  });

  it('resolves one @livekit/rtc-node for both this package and @livekit/agents', () => {
    const agentsDir = packageRoot(packageDir, '@livekit/agents');
    const ours = packageRoot(packageDir, '@livekit/rtc-node');
    const agents = packageRoot(agentsDir, '@livekit/rtc-node');
    expect(agents).toBe(ours);
    expect(version(agentsDir)).toBe('1.9.3');
    expect(version(ours)).toBe('1.1.0');
  });

  it("satisfies @livekit/agents' own rtc-node peer range", () => {
    const agentsDir = packageRoot(packageDir, '@livekit/agents');
    const peer = (
      JSON.parse(readFileSync(join(agentsDir, 'package.json'), 'utf8')) as {
        peerDependencies: Record<string, string>;
      }
    ).peerDependencies['@livekit/rtc-node'];
    expect(peer).toBe('^1.1.0');
  });
});
