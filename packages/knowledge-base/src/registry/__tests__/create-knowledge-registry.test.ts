import { describe, expect, it } from 'vitest';
import { defineKnowledgeSource } from '../../define/defineKnowledgeSource.js';
import { createKnowledgeRegistry } from '../create-knowledge-registry.js';
import { staticBlocks } from '../../providers/static-blocks.js';

describe('createKnowledgeRegistry', () => {
  const help = defineKnowledgeSource({
    name: 'help-kb',
    provider: staticBlocks({ blocks: [{ text: 'help' }] }),
  });
  const product = defineKnowledgeSource({
    name: 'product-kb',
    provider: staticBlocks({ blocks: [{ text: 'product' }] }),
  });

  it('get returns source', () => {
    const registry = createKnowledgeRegistry({ sources: [help, product] });
    expect(registry.get('help-kb').name).toBe('help-kb');
  });

  it('has and list work', () => {
    const registry = createKnowledgeRegistry({ sources: [help] });
    expect(registry.has('help-kb')).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it('throws on missing source', () => {
    const registry = createKnowledgeRegistry({ sources: [help] });
    expect(() => registry.get('missing')).toThrow(/knowledge\.source_not_found/);
  });

  it('throws on duplicate names', () => {
    expect(() =>
      createKnowledgeRegistry({
        sources: [help, help],
      }),
    ).toThrow(/knowledge\.duplicate_source/);
  });
});
