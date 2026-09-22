import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('@plumbus/voice/client bundle', () => {
  it('does not import Node-only voice runtime dependencies', () => {
    const clientEntry = readFileSync(join(packageRoot, 'dist/client/index.js'), 'utf8');
    // Built from parts so a repo-wide vendor-string search does not false-positive on this file.
    const serverSdk = ['livekit', 'server', 'sdk'].join('-');
    const rtcNode = `@${['livekit', 'rtc-node'].join('/')}`;
    expect(clientEntry).not.toContain(serverSdk);
    expect(clientEntry).not.toContain(rtcNode);
    expect(clientEntry).not.toMatch(/from ['"]ws['"]/);
    expect(clientEntry).not.toContain('node:fs');
  });
});
