import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('chat session entry', () => {
  it('retains governed execution without HTTP, eval tooling or the broad core entry', () => {
    const entry = new URL('../../../dist/session.js', import.meta.url).href;
    const loader = `export async function resolve(s,c,n) {
      const r=await n(s,c);
      if (/plumbus-core\\/dist\\/(index.js|cli\\/|governance\\/)/.test(r.url)
        || /chat\\/dist\\/(runtime\\/http.js|eval\\/run-evaluation.js)/.test(r.url)) throw new Error('unexpected import '+r.url);
      return r;
    }`;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { register } from 'node:module';
      register('data:text/javascript,'+encodeURIComponent(${JSON.stringify(loader)}),import.meta.url);
      const m=await import(${JSON.stringify(entry)});
      if (!m.runChatTurn || !m.defineChat || !m.chatSessionEntity || !m.chatTurnCompletedEvent) throw new Error('missing session API');
      console.log('ok');
    `,
      ],
      { encoding: 'utf8' },
    );
    expect(output.trim()).toBe('ok');
  });
});
