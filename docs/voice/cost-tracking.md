# Voice Cost Tracking

Voice spend belongs in the same AI ledger as text prompts. `@plumbus/voice` does not create a parallel billing system; it writes STT/TTS/transport usage into the shared `onAICostRecorded` flow.

## Operations

Use these `operation` values:

- `transcribe` — STT
- `synthesize` — TTS
- `transport` — realtime session infrastructure

## `recordVoiceCost(...)`

Use `recordVoiceCost(...)` when the provider call did not already flow through a core `ctx.ai.*` helper.

```ts
await recordVoiceCost(
  { ai: ctx.ai },
  {
    operation: 'transport',
    provider: 'livekit',
    model: 'livekit-cloud',
    mediaUsage: {
      connectionMinutes: 2,
      participantMinutes: 4,
    },
    latencyMs: 120_000,
    costContext: {
      projectId: 'memoir',
      serviceArea: 'voice',
      operationName: 'voice.transport',
    },
  },
);
```

## Rollups

Typical rollup dimensions:

- per turn (`sessionId` / turn identifier in `costContext`)
- per session
- per user / tenant
- per provider or model

Voice costs are easiest to reason about when they sit next to LLM costs in one reporting path.

## Session budgets

`createVoiceSessionBudget()` is the package-level helper for session-scoped caps such as:

- max connection minutes
- max participant minutes
- max audio input seconds
- max concurrent streams
- max STT characters relayed in a session

Pass the config through `registerVoiceRoutes({ sessionBudget: { ... } })`. WebSocket sessions also honor optional lifecycle limits via `sessionLifecycle` or the same budget config:

- `maxSessionDurationSeconds`
- `idleTimeoutSeconds`

That complements the core AI budget layer, which is primarily token/USD oriented.

## Pre-turn daily budget checks

Before a turn starts, `runVoiceTurn()` calls:

```ts
ctx.ai.checkProviderCostBudget({
  estimatedCostUsd: estimateVoiceTurnCost({ voice }).estimatedCostUsd,
});
```

Use this to block runaway STT/TTS spend against the shared daily cap without waiting for post-hoc ledger rollups.

## `cost: null`

Unknown pricing is not the same as zero usage.

Use `cost: null` when:

- the provider/model is known but current pricing is unavailable
- you still want to preserve usage volume in the ledger

Use `0` only when the pricing model truly evaluates to zero.

## Transport estimates

Realtime transport is often estimated rather than measured as exact provider billing. When in doubt:

- prefer `participantMinutes` over only `connectionMinutes`
- document estimation strategy
- keep it queryable via the shared ledger

## Related docs

- [testing.md](./testing.md)
- [security.md](./security.md)
- [../ai/ai-integration.md](../ai/ai-integration.md)
