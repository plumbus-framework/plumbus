# Voice Cost Tracking — Agent Recipe

Voice spend belongs in the same AI ledger as text prompts.

## Use these operations

- `transcribe` for STT
- `synthesize` for TTS
- `transport` for session infrastructure (for example LiveKit)

## What to record

- `provider`
- `model`
- `mediaUsage` (`audioInputSeconds`, `audioOutputSeconds`, `characters`, `connectionMinutes`, `participantMinutes`)
- `cost`
- `latencyMs`
- `costContext` with app-specific rollup metadata — **must include `projectId`** or `onAICostRecorded` skips the ledger row
- stable `operationName` values such as `voice.transcribe`, `voice.synthesize`, `voice.transport`

## Helper

Use `recordVoiceCost(...)` when the provider call did not already flow through a core AI helper.

Before starting a turn, the runtime may call:

```ts
ctx.ai.checkProviderCostBudget({ estimatedCostUsd });
```

## Rules

- **Do** keep voice spend queryable through `onAICostRecorded`.
- **Do** use `participantMinutes` for multi-party realtime transport spend.
- **Do** preserve `cost: null` when pricing is unknown; that still records usage volume without fabricating USD.
- **Do** wire `createVoiceSessionBudget()` for per-session audio/STT caps.
- **Don't** create a separate billing ledger just for voice.

## Deeper reference

- `/docs/voice/cost-tracking.md`
- `/docs/ai/ai-integration.md`
