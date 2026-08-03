import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const clientDistPath = join(packageRoot, 'dist/client.js');
const clientDir = join(packageRoot, 'dist/client');

function collectJsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

describe('client bundle guard', () => {
  it('keeps Node/server LiveKit deps out of dist/client.js', () => {
    const source = readFileSync(clientDistPath, 'utf8');
    expect(source).not.toContain('@livekit/rtc-node');
    expect(source).not.toContain('livekit-server-sdk');
    expect(source).not.toContain('node:fs');
    expect(source).not.toContain("from 'ws'");
  });

  it('does not import @plumbus/core or @plumbus/voice package roots from client modules', () => {
    const sources = [clientDistPath, ...collectJsFiles(clientDir)].map((path) =>
      readFileSync(path, 'utf8'),
    );
    const combined = sources.join('\n');
    // Root barrels pull CLI / server runtime into the Next client graph.
    expect(combined).not.toMatch(/from ['"]@plumbus\/core['"]/);
    expect(combined).not.toMatch(/from ['"]@plumbus\/voice['"]/);
    // Allowed browser-safe subpaths.
    expect(combined).toMatch(/@plumbus\/core\/errors/);
    expect(combined).toMatch(/@plumbus\/voice\/noise-cancellation/);
  });
});
