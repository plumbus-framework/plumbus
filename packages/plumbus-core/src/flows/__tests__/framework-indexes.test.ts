// The framework-table indexes core 0.9.0-beta.15 adds reach an app through `plumbus migrate
// generate`: an app on the previous snapshot gets one idempotent CREATE INDEX per index and
// nothing else, which it can turn into a `-- plumbus:no-transaction` concurrent build
// (framework-indexes.pg.test.ts applies exactly that).

import { describe, expect, it } from 'vitest';
import { ADDED_FRAMEWORK_INDEXES, generatedIndexStatements } from './framework-indexes-fixture.js';

describe('framework-table indexes in app migrations', () => {
  it('an app on the previous snapshot gets one idempotent CREATE INDEX per added index', async () => {
    const rewritten = await generatedIndexStatements();
    expect(rewritten).toHaveLength(Object.keys(ADDED_FRAMEWORK_INDEXES).length);
    for (const [name, parts] of Object.entries(ADDED_FRAMEWORK_INDEXES)) {
      const statement = rewritten.find((text) => text.includes(`"${name}"`));
      expect(statement, name).toContain(`CREATE INDEX IF NOT EXISTS "${name}"`);
      for (const part of parts) expect(statement, name).toContain(part);
    }
  });
});
