import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);

function readManifest(name: string): {
  version: string;
  peerDependencies: Record<string, string>;
} {
  return JSON.parse(readFileSync(new URL(`packages/${name}/package.json`, repositoryRoot), 'utf8'));
}

describe('packages integrated into the core 0.8 family', () => {
  it.each([
    'ai-decision-openai',
    'payments',
    'payments-stripe',
  ])('%s requires the beta core family and stays outside legacy release ranges', (name) => {
    const manifest = readManifest(name);
    expect(manifest.version).toMatch(/^0\.3\.0-beta\.\d+$/);
    expect(manifest.peerDependencies['@plumbus/core']).toBe('>=0.8.0-beta.0 <0.9.0');
  });

  it('the Stripe provider requires the matching payments family', () => {
    expect(readManifest('payments-stripe').peerDependencies['@plumbus/payments']).toBe(
      '>=0.3.0-beta.0 <0.4.0',
    );
  });

  it('every publication uses the branch-selected npm dist-tag', () => {
    const workflow = readFileSync(new URL('.github/workflows/publish.yml', repositoryRoot), 'utf8');
    const publishCommands = workflow.split('\n').filter((line) => /^\s+pnpm publish\s/.test(line));
    expect(publishCommands.length).toBeGreaterThan(0);
    for (const command of publishCommands) {
      expect(command).toContain('--tag "$DIST_TAG"');
    }
    for (const name of ['ai-decision-openai', 'payments', 'payments-stripe']) {
      expect(workflow).toContain(`working-directory: packages/${name}\n`);
    }
  });
});
