# Voice Cost Tracking

Voice spend belongs in the same AI ledger as text prompts. `@plumbus/voice` does not create a parallel billing system; it writes STT/TTS/transport usage into the shared `onAICostRecorded` flow.

## Required `costContext.projectId`

Ledger rows are written only when `costContext.projectId` is present. Thread it from the voice brain input (for example `brainInput.projectId` on LiveKit participant metadata) through:

- `recordProviderUsage()` — per-turn STT and TTS after `runVoiceTurn()`
- `recordLiveKitTransportCost()` — on LiveKit agent shutdown
- `recordDirectUtteranceCost()` — auxiliary TTS (backchannels, hearing repair, `tts.speak` replay)

Without `projectId`, `onAICostRecorded` skips the row silently.

## Operation names

Use stable `costContext.operationName` values (not turn UUIDs):

| Operation | When |
|-----------|------|
| `voice.transcribe` | STT usage after a turn |
| `voice.synthesize` | Main reply TTS after a turn |
| `voice.transport` | LiveKit session on agent shutdown |
| `voice.backchannel` | Continuer TTS during a pause |
| `voice.hearing_repair` | Repair-prompt TTS |
| `voice.replay` | Client `tts.speak` replay |

App-owned LLM adjuncts (for example `interview.classify_tone`) should pass the same `costContext` shape into `ctx.ai.generateWithUsage` or call `recordAICost` directly.

## Model pricing keys

Provider `usage()` may report vendor model IDs (`stt-rt-v5`, `dd-etts-3.2`). `recordProviderUsage()` maps them to ledger pricing keys via `resolveSttCostModelKey` / `resolveTtsCostModelKey` (for example `soniox-stt`, `deepdub-phantom-x`) so `calculateVoiceCost` returns non-null USD.

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
      projectId: 'acme',
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
