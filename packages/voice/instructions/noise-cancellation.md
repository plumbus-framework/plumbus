# Noise cancellation (`transport.options.noiseCancellation`)

Plumbus voice supports **one** enhanced noise-cancellation chain per session. Never stack client and agent NC on the same audio path.

## Config shape

```typescript
transport: {
  provider: 'livekit',
  options: {
    noiseCancellation: {
      placement: 'off' | 'client' | 'agent',
      engine?: 'krisp' | 'dtln' | 'rnnoise', // default 'krisp' when placement !== 'off'
      model?: 'standard' | 'bvc' | 'lite',
      dtlnModelDir?: string, // agent + dtln only
    },
  },
}
```

## Matrix

| placement | engine | model | Package | LiveKit Cloud |
|-----------|--------|-------|---------|---------------|
| `client` | `krisp` | `standard` \| `bvc` | `@livekit/krisp-noise-filter` | Required |
| `client` | `rnnoise` | `standard` \| `lite` | `@shiguredo/rnnoise-wasm` | No |
| `agent` | `krisp` | `standard` \| `bvc` | `@livekit/noise-cancellation-node` | Required |
| `agent` | `dtln` | `standard` | ONNX Runtime + model dir | No |
| `agent` | `rnnoise` | `standard` \| `lite` | `@shiguredo/rnnoise-wasm` | No |

## Switching browser vs server Krisp

Change `placement` only:

- Browser: `{ placement: 'client', engine: 'krisp', model: 'bvc' }`
- Worker: `{ placement: 'agent', engine: 'krisp', model: 'bvc' }`

LiveKit token responses include serialized `noiseCancellation` so `createLiveKitVoiceSession()` applies client engines automatically.

## Mic constraints

When any enhanced NC is active, keep `noiseSuppression: false` on WebRTC capture (Krisp/OSS replaces browser NS).

## Fallback

If an engine fails to load (missing native binary, WASM, or DTLN models), Plumbus logs a warning and ingests raw audio — sessions continue.

## Related

- [`transports.md`](../../../docs/voice/transports.md)
- [`framework.md`](./framework.md)
