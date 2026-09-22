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
- `costContext` with app-specific rollup metadata — include `projectId` when the app-owned ledger requires it; the framework hook does not require it
- stable `operationName` values such as `voice.transcribe`, `voice.synthesize`, `voice.transport`, `voice.backchannel`, `voice.hearing_repair`, `voice.replay`

## Helper

Use `recordVoiceCost(...)` when the provider call did not already flow through a core AI helper. Import `recordLiveKitTransportCost(...)` from `@plumbus/voice-livekit` (it owns LiveKit transport pricing and passes an explicit `cost` into `recordVoiceCost`).

Cloud/vendor add-on packages own their pricing constants (`SONIOX_VOICE_PRICING`, `DEEPDUB_VOICE_PRICING`, …) and attach them on `*_REGISTRATION.pricing`. `createProviderRegistry()` calls `registerVoicePricing()` for those rows so `lookupVoicePricing` / `calculateVoiceCost` / `recordVoiceCost` return real USD. Built-in provider keys stay in `@plumbus/voice`. `recordVoiceCost` still accepts an optional `cost` override (LiveKit transport uses this).

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


Reference synthesis also records attempts through the configured AI ledger. Unknown pricing stays `null` there; a numeric compatibility result with `costAvailable: false` must not be converted to free spend. Voice-only/local deployments without an AI ledger remain supported. Read the core security release checklist before upgrading a custom ledger.
