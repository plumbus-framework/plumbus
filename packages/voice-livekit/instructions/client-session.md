# LiveKit browser session — Agent Recipe

Use this after installing `@plumbus/voice-livekit` when wiring a **browser** PTT or continuous client.

**Exact path in a consumer app:**

`node_modules/@plumbus/voice-livekit/instructions/client-session.md`

## Rules

1. Import session helpers from **`@plumbus/voice-livekit/client` only** — never import the package root into a browser bundle.
2. Install `livekit-client` for the browser (optional peer).
3. Mint tokens via Plumbus `POST /api/voice/:name/token` — do not hand-roll LiveKit JWTs for Plumbus voice sessions.
4. Client noise cancellation is applied by the session helper when the token payload includes serialized NC options.

## Minimal wire-up

```ts
import { createLiveKitVoiceSession } from '@plumbus/voice-livekit/client';

const session = await createLiveKitVoiceSession({
  // fields from /api/voice/:name/token response (url, token, noiseCancellation, …)
});
await session.connect();
// … push-to-talk / continuous UI …
await session.disconnect();
```

Optional explicit client NC:

```ts
import { applyClientNoiseCancellation } from '@plumbus/voice-livekit/client';
```

Prefer letting `createLiveKitVoiceSession` apply NC from the token response.

## Mic capture (do not override)

`createLiveKitVoiceSession` publishes the mic with `voiceIsolation: false`, Opus `dtx: false`, and `red: true`. livekit-client would otherwise default `voiceIsolation` on (a hidden enhancement stage in front of STT). DTX can swallow quiet onsets. Do **not** re-enable browser voice isolation or DTX “for quality,” and do **not** put client Krisp BVC on the STT path — see [`noise-cancellation.md`](./noise-cancellation.md).

Continuous talk-over / transcript / chunker behavior lives on the parent package: `node_modules/@plumbus/voice/instructions/continuous-sessions.md`.

## Related recipes

| Task | Read |
|---|---|
| Install / register transport | [`framework.md`](./framework.md) |
| Agent worker / `plumbus voice worker` | [`agent-worker.md`](./agent-worker.md) |
| Noise cancellation matrix | [`noise-cancellation.md`](./noise-cancellation.md) |
| Parent voice security / routes | `node_modules/@plumbus/voice/instructions/security.md` |

Concept docs (monorepo): `docs/voice/livekit-continuous-voice.md`.
