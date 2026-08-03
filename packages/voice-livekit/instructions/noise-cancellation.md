# LiveKit noise cancellation — Agent Recipe

Use this when configuring `transport.options.noiseCancellation` for a LiveKit voice.

**Exact path in a consumer app:**

`node_modules/@plumbus/voice-livekit/instructions/noise-cancellation.md`

Parent overview (same config shape, package boundary):  
`node_modules/@plumbus/voice/instructions/noise-cancellation.md`

## Rules

1. **One NC chain per session** — never stack client + agent NC on the same path.
2. Client apply: `applyClientNoiseCancellation` from `@plumbus/voice-livekit/client`.
3. Agent inbound: `createInboundAudioStream` / `resolveAgentNoiseCancellationOption` from `@plumbus/voice-livekit`.
4. Parse/serialize helpers stay on `@plumbus/voice`; engines live here.

## Config

```ts
transport: {
  provider: 'livekit',
  options: {
    noiseCancellation: {
      placement: 'off' | 'client' | 'agent',
      engine?: 'krisp' | 'dtln' | 'rnnoise',
      model?: 'standard' | 'bvc' | 'lite',
      dtlnModelDir?: string, // agent + dtln only
    },
  },
}
```

## Matrix

| placement | engine | model | Extra package | LiveKit Cloud |
|---|---|---|---|---|
| `client` | `krisp` | `standard` \| `bvc` | `@livekit/krisp-noise-filter` | Required |
| `client` | `rnnoise` | `standard` \| `lite` | `@shiguredo/rnnoise-wasm` | No |
| `agent` | `krisp` | `standard` \| `bvc` | `@livekit/noise-cancellation-node` | Required |
| `agent` | `dtln` | `standard` | ONNX Runtime + model dir | No |
| `agent` | `rnnoise` | `standard` \| `lite` | `@shiguredo/rnnoise-wasm` | No |

Token responses include serialized NC so `createLiveKitVoiceSession()` can apply client engines automatically.

## Related recipes

| Task | Read |
|---|---|
| Browser session | [`client-session.md`](./client-session.md) |
| Agent worker | [`agent-worker.md`](./agent-worker.md) |
| Install / register | [`framework.md`](./framework.md) |

Concept docs (monorepo): `docs/voice/noise-cancellation.md`.
