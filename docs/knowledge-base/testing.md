# Testing

Import helpers from `@plumbus/knowledge-base/testing` (devDependency / test-only).

```ts
import {
  createTestRegistry,
  mockKnowledgeSource,
  expectKnowledgeCalled,
} from '@plumbus/knowledge-base/testing';
import { defineKnowledgeSource } from '@plumbus/knowledge-base';
```

## `mockKnowledgeSource`

Fastest path to a registry-backed source with fixed tier-1 text:

```ts
const source = mockKnowledgeSource('help facts for tests', {
  name: 'mock-kb',
  scope: { audience: 'user' }, // stored on KnowledgeSourceDefinition.scope (metadata)
});

// source is a KnowledgeSource from an internal one-entry registry
const text = await source.getBlock(ctx, { audience: 'user' });
expect(text).toBe('help facts for tests');
```

Use in chat tests:

```ts
import { knowledgeContext, resolveContextSources } from '@plumbus/chat';

const mock = mockKnowledgeSource('grounding', { name: 'mock-kb' });
const registry = createTestRegistry([mock.definition]);
```

`mockKnowledgeSource` returns a runtime `KnowledgeSource`; use `.definition` when you need the frozen config for `createTestRegistry`. The optional `scope` is persisted on `definition.scope` for fixtures that assert registry metadata — `getBlock` still returns the fixed string unless you customize the provider.

Prefer this over ad hoc `{ async getBlock() {} }` literals so tests stay aligned when the provider contract evolves.

## `createTestRegistry`

```ts
const registry = createTestRegistry([
  defineKnowledgeSource({
    name: 'help-kb',
    provider: staticBlocks({ blocks: [{ text: 'tip' }] }),
  }),
  mockKnowledgeSource('other', { name: 'other-kb' }).definition,
]);

expect(registry.has('help-kb')).toBe(true);
await registry.get('help-kb').getBlock(ctx, { audience: 'user' });
```

Same implementation as production `createKnowledgeRegistry` — duplicate names still throw `knowledge.duplicate_source`.

## `expectKnowledgeCalled`

Assert a **spy** recorded a provider call with expected method and partial scope:

```ts
const calls: Array<{ method: string; scope?: KnowledgeScope }> = [];

const provider = {
  async getBlock(_ctx, scope) {
    calls.push({ method: 'getBlock', scope });
    return 'ok';
  },
};

const registry = createTestRegistry([
  defineKnowledgeSource({ name: 'spy-kb', provider }),
]);

await registry.get('spy-kb').getBlock(ctx, { audience: 'admin', locale: 'en' });

expectKnowledgeCalled(
  { calls },
  { method: 'getBlock', scope: { audience: 'admin' } },
);
```

Partial `scope` in expectations — only listed keys must match.

Use after exercising `knowledgeContext` + `resolveContextSources` if you wrap the provider with a spy instead of mocking AI retrieve.

## Chat integration test pattern

```ts
import { createTestContext, mockAI } from '@plumbus/core/testing';
import { createKnowledgeRegistry, defineKnowledgeSource, ragCorpus } from '@plumbus/knowledge-base';
import { knowledgeContext, resolveContextSources } from '@plumbus/chat';

const retrieve = vi.fn(async () => [{ content: 'hit', score: 1, source: 's' }]);
const registry = createKnowledgeRegistry({
  sources: [defineKnowledgeSource({ name: 'rag-kb', provider: ragCorpus({ corpus: 'help' }) })],
});

await resolveContextSources(
  createTestContext({ ai: { ...mockAI(), retrieve } }),
  [knowledgeContext({ registry, source: 'rag-kb', queryFromTurn: (t) => t.userMessage ?? '' })],
  { ...turnCtx, userMessage: 'billing question' },
  { perSourceTimeoutMs: 1000, onError: 'fail' },
);

expect(retrieve).toHaveBeenCalledWith(
  expect.objectContaining({ query: 'billing question' }),
);
```

## Unit test placement

Package tests live under `packages/knowledge-base/src/**/__tests__/`. Consumer app tests import `@plumbus/knowledge-base/testing` — do not add KB to production `dependencies` unless the app uses KB at runtime.
