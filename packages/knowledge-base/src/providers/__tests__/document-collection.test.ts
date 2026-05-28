import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { documentCollection } from '../document-collection.js';

describe('documentCollection', () => {
  const ctx = createTestContext();

  it('reads markdown and filters by frontmatter scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-docs-'));
    await writeFile(
      join(dir, 'user.md'),
      '---\naudience: user\nlocale: en\n---\nUser doc body',
      'utf8',
    );
    await writeFile(join(dir, 'admin.md'), '---\naudience: admin\n---\nAdmin only', 'utf8');

    const provider = documentCollection({ root: dir });
    const block = await provider.getBlock(ctx, { audience: 'user', locale: 'en' });
    expect(block).toContain('User doc body');
    expect(block).not.toContain('Admin only');
  });

  it('caches reads across calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-docs-cache-'));
    const file = join(dir, 'one.md');
    await writeFile(file, 'cached body', 'utf8');
    const provider = documentCollection({ root: dir });
    await provider.getBlock(ctx, {});
    await writeFile(file, 'mutated body', 'utf8');
    const block = await provider.getBlock(ctx, {});
    expect(block).toContain('cached body');
  });
});
