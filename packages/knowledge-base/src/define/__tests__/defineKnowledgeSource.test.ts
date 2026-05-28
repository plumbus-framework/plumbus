import { describe, expect, it } from 'vitest';
import { defineKnowledgeSource } from '../defineKnowledgeSource.js';
import { staticBlocks } from '../../providers/static-blocks.js';
describe('defineKnowledgeSource', () => {
  it('accepts valid config', () => {
    const def = defineKnowledgeSource({
      name: 'help-kb',
      provider: staticBlocks({ blocks: [{ text: 'hello' }] }),
    });
    expect(def.name).toBe('help-kb');
  });

  it('rejects missing name', () => {
    expect(() =>
      defineKnowledgeSource({
        name: '',
        provider: staticBlocks({ blocks: [] }),
      }),
    ).toThrow(/knowledge\.define_invalid/);
  });

  it('rejects invalid name', () => {
    expect(() =>
      defineKnowledgeSource({
        name: 'Help_KB',
        provider: staticBlocks({ blocks: [] }),
      }),
    ).toThrow(/knowledge\.define_invalid/);
  });

  it('rejects missing getBlock', () => {
    expect(() =>
      defineKnowledgeSource({
        name: 'bad',
        provider: {} as never,
      }),
    ).toThrow(/knowledge\.define_invalid/);
  });
});
