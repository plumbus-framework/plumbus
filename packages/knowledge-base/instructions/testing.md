# Testing — Agent Recipe

Import from `@plumbus/knowledge-base/testing` in tests only. Full patterns: `docs/knowledge-base/testing.md` in the Plumbus monorepo.

## Prefer framework helpers

```ts
import {
  createTestRegistry,
  mockKnowledgeSource,
  expectKnowledgeCalled,
} from '@plumbus/knowledge-base/testing';
```

## Quick patterns

**Fixed tier-1 text:**

```ts
const mock = mockKnowledgeSource('grounding text', { name: 'mock-kb', scope: { audience: 'user' } });
// scope is stored on definition.scope (metadata); customize provider to filter by it
const registry = createTestRegistry([mock.definition]);
```

**Spy provider:**

```ts
const calls: Array<{ method: string; scope?: KnowledgeScope }> = [];
const registry = createTestRegistry([
  defineKnowledgeSource({
    name: 'spy-kb',
    provider: {
      async getBlock(_ctx, scope) {
        calls.push({ method: 'getBlock', scope });
        return 'ok';
      },
    },
  }),
]);
await registry.get('spy-kb').getBlock(ctx, { audience: 'admin' });
expectKnowledgeCalled({ calls }, { method: 'getBlock', scope: { audience: 'admin' } });
```

**Chat + RAG:** mock `ctx.ai.retrieve` via `createTestContext({ ai: { ...mockAI(), retrieve } })` and assert retrieve args after `resolveContextSources`.

## Do / Don't

| Do | Don't |
|---|---|
| `createTestRegistry` (same freeze/duplicate rules as prod) | Ad-hoc `{ async getBlock() {} }` without mocks when testing registry contract |
| `.definition` from `mockKnowledgeSource` for registry arrays | Add `@plumbus/knowledge-base` to prod `dependencies` only for tests |
