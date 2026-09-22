import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = join(packageRoot, 'src');

// Built from parts so a repo-wide vendor-string search does not false-positive on this file.
const VENDOR_SCOPES = ['livekit', 'shiguredo', 'deepdub', 'soniox'] as const;
const VENDOR_DEP_PATTERN = new RegExp(`^(?:@${VENDOR_SCOPES.join('/|^@')}/|^livekit-)`);
const VOICE_ADDON_PACKAGES = [
  '@plumbus/voice-deepdub',
  '@plumbus/voice-soniox',
  '@plumbus/voice-elevenlabs',
  '@plumbus/voice-minimax',
  '@plumbus/voice-livekit',
  '@plumbus/voice-openai',
] as const;

const VENDOR_IMPORT_PATTERN = new RegExp(
  `(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)['"](@(?:${VENDOR_SCOPES.join('|')})/[^'"]+|livekit-[^'"]+)['"]`,
);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkTsFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('dependency hygiene', () => {
  it('does not peer-depend on voice add-on packages', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    for (const peer of VOICE_ADDON_PACKAGES) {
      expect(pkg.peerDependencies?.[peer]).toBeUndefined();
      expect(pkg.dependencies?.[peer]).toBeUndefined();
      expect(pkg.optionalDependencies?.[peer]).toBeUndefined();
      expect(pkg.peerDependenciesMeta?.[peer]).toBeUndefined();
    }
  });

  it('has no vendor SDK dependencies or peers', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    for (const [name] of Object.entries(pkg.dependencies ?? {})) {
      expect(name).not.toMatch(VENDOR_DEP_PATTERN);
    }
    for (const [name] of Object.entries(pkg.peerDependencies ?? {})) {
      expect(name).not.toMatch(VENDOR_DEP_PATTERN);
    }
  });

  it('has no vendor SDK imports under src/', () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(srcRoot)) {
      const content = readFileSync(file, 'utf8');
      if (VENDOR_IMPORT_PATTERN.test(content)) {
        offenders.push(file.replace(`${packageRoot}/`, ''));
      }
    }
    expect(offenders).toEqual([]);
  });
});
