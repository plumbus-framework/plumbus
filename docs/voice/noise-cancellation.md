# Noise cancellation

Plumbus voice supports **one** enhanced noise-cancellation (NC) chain per session. Never stack client and agent NC on the same audio path.

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

| placement | engine | model | Package | LiveKit Cloud |
|-----------|--------|-------|---------|---------------|
| `client` | `krisp` | `standard` \| `bvc` | `@livekit/krisp-noise-filter` | Required |
| `client` | `rnnoise` | `standard` \| `lite` | `@shiguredo/rnnoise-wasm` | No |
| `agent` | `krisp` | `standard` \| `bvc` | `@livekit/noise-cancellation-node` | Required |
| `agent` | `dtln` | `standard` | ONNX Runtime + `dtlnModelDir` | No |
| `agent` | `rnnoise` | `standard` \| `lite` | `@shiguredo/rnnoise-wasm` | No |

Switch browser vs worker Krisp by changing `placement` only — keep the same `engine`/`model` pair.

## Wire format and helpers

LiveKit token responses include serialized `noiseCancellation` so `createLiveKitVoiceSession()` can apply client engines automatically.

Public parse/apply helpers (from `@plumbus/voice`):

| Export | Purpose |
|--------|---------|
| `parseNoiseCancellation` | Validate/normalize config from voice definition |
| `readNoiseCancellationFromTransportOptions` | Read NC block from transport options |
| `serializeNoiseCancellation` | Embed in LiveKit session/token payloads |
| `assertExclusiveNoiseCancellation` | Reject client+agent stacking |
| `applyClientNoiseCancellation` | Browser-side engine wiring |
| `resolveAgentNoiseCancellationOption` | Worker-side engine selection |
| `createInboundAudioStream` | Agent inbound PCM pipeline with NC |

## Mic constraints

When any enhanced NC is active, keep `noiseSuppression: false` on WebRTC capture — Krisp/OSS replaces browser noise suppression.

## Fallback

If an engine fails to load (missing native binary, WASM, or DTLN models), Plumbus logs a warning and ingests raw audio. Sessions continue without NC.

## Related docs

- [transports.md](./transports.md) — when to pick LiveKit vs raw WebSocket
- [`packages/voice/instructions/noise-cancellation.md`](../../packages/voice/instructions/noise-cancellation.md) — agent recipe
