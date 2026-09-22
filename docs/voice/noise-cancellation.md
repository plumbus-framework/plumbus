# Noise cancellation

Plumbus voice supports **one** enhanced noise-cancellation (NC) chain per session. Never stack client and agent NC on the same audio path.

Enhanced NC runs on the LiveKit transport, so install `@plumbus/voice-livekit` — it carries the engine packages listed below. `@plumbus/voice` keeps only the config parse/serialize helpers.

Configure on the voice definition:

```ts
defineVoice({
  transport: {
    provider: 'livekit',
    options: {
      noiseCancellation: {
        placement: 'client', // 'off' | 'client' | 'agent'
        engine: 'krisp',     // 'krisp' | 'dtln' | 'rnnoise'
        model: 'standard',   // engine-specific
      },
    },
  },
  // ...
});
```

## Placement matrix

Engine packages ship as dependencies (or optional browser peers) of `@plumbus/voice-livekit`:

| placement | engine | model | Engine package | LiveKit Cloud |
|-----------|--------|-------|----------------|---------------|
| `client` | `krisp` | `standard` \| `bvc` | `@livekit/krisp-noise-filter` | Required |
| `client` | `rnnoise` | `standard` \| `lite` | `@shiguredo/rnnoise-wasm` | No |
| `agent` | `krisp` | `standard` \| `bvc` | `@livekit/noise-cancellation-node` | Required |
| `agent` | `dtln` | `standard` | ONNX Runtime + `dtlnModelDir` | No |
| `agent` | `rnnoise` | `standard` \| `lite` | `@shiguredo/rnnoise-wasm` | No |

Switch browser vs worker Krisp by changing `placement` only — keep the same `engine`/`model` pair.

## Wire format and helpers

LiveKit token responses include serialized `noiseCancellation` so `createLiveKitVoiceSession()` from `@plumbus/voice-livekit/client` can apply client engines automatically.

Public parse helpers (from `@plumbus/voice`); client/agent apply helpers live on `@plumbus/voice-livekit`:

| Export | Purpose |
|--------|---------|
| `parseNoiseCancellation` | Validate/normalize config from voice definition |
| `readNoiseCancellationFromTransportOptions` | Read NC block from transport options |
| `serializeNoiseCancellation` | Embed in LiveKit session/token payloads |
| `assertExclusiveNoiseCancellation` | Reject client+agent stacking |
| `applyClientNoiseCancellation` | Browser-side engine wiring — import from `@plumbus/voice-livekit/client` |
| `resolveAgentNoiseCancellationOption` | Worker-side engine selection — import from `@plumbus/voice-livekit` |
| `createInboundAudioStream` | Agent inbound PCM pipeline with NC — import from `@plumbus/voice-livekit` |

## Mic constraints

When any enhanced NC is active, keep `noiseSuppression: false` on WebRTC capture — Krisp/OSS replaces browser noise suppression.

## Fallback

If an engine fails to load (missing native binary, WASM, or DTLN models), Plumbus logs a warning and ingests raw audio. Sessions continue without NC.

## Related docs

- [transports.md](./transports.md) — when to pick LiveKit vs raw WebSocket
- [`packages/voice/instructions/noise-cancellation.md`](../../packages/voice/instructions/noise-cancellation.md) — agent recipe
