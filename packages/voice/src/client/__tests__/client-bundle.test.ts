import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('@plumbus/voice/client bundle', () => {
  it('does not import Node-only voice runtime dependencies', () => {
    const clientEntry = readFileSync(join(packageRoot, 'dist/client/index.js'), 'utf8');
    expect(clientEntry).not.toContain('livekit-server-sdk');
    expect(clientEntry).not.toContain('@livekit/rtc-node');
    expect(clientEntry).not.toMatch(/from ['"]ws['"]/);
    expect(clientEntry).not.toContain('node:fs');
  });
});
