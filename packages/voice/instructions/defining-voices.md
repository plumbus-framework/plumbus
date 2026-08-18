# Defining a Voice — Agent Recipe

Use this when the user asks to add a new voice surface.

## Minimal recipe

1. Declare one `defineVoice({...})` config.
2. Include `access`.
3. Pick one transport, one STT provider, and one TTS provider. If any id is `livekit`, `soniox`, `deepdub`, `elevenlabs`, or `minimax`, also install its `@plumbus/voice-*` add-on (see [`providers.md`](./providers.md)) and pass that package’s `*_REGISTRATION` into `createProviderRegistry()`. Install alone does **not** register.
4. Implement `brain.run(ctx, args)` using normal Plumbus primitives and `ctx.*`.
5. Mount it with `registerVoiceRoutes()`.

## Skeleton

```ts
const supportVoice = defineVoice({
  name: 'supportVoice',
  access: { roles: ['user'] },
  transport: { provider: 'websocket', mode: 'pushToTalk' },
  stt: { provider: 'web-speech', languages: ['en-US'] },
  tts: { provider: 'browser-tts', locale: 'en-US' },
  brain: {
    async run(ctx, args) {
      return { text: `You said: ${args.transcript ?? ''}` };
    },
  },
});
```

## Mounting routes

```ts
registerVoiceRoutes(app, routeConfig, [supportVoice], {
  providers,
  sessionTokenSecret: process.env['VOICE_SESSION_TOKEN_SECRET'],
  websocketOriginAllowlist: ['https://app.example.com'],
});
```

## Tone hooks

- `toneProfiles` declares named delivery presets.
- `resolveTone(ctx, args)` chooses the tone profile per turn. It may also return `voiceId` and `targetGender` on `DeliveryTone`.
- `DeliveryTone.voiceId` is a per-turn voice override (Deepdub style-variant `voicePromptId` of the same speaker). Providers without per-call voice selection ignore it.
- `preprocessForTts(text, ctx)` can normalize or annotate output before TTS.
- For Soniox STT (`@plumbus/voice-soniox`), set `stt.options.contextTerms` to send `context.terms` for domain vocabulary. A single hinted language also sends `language_hints_strict` unless `stt.options.languageHintsStrict` overrides it. TTS uses the same package (`SONIOX_TTS_REGISTRATION`, `tts.provider: 'soniox'`).

Use the hooks for delivery behavior, not for app business logic.

Continuous / always-listening server-STT behavior (talk-over re-queue, stitched `stt.*` events, sentence chunker, opt-in backchannel) is in [`continuous-sessions.md`](./continuous-sessions.md). Read that before adding timers, phrase pools, or transcript-stitch helpers.

## Don'ts

- **Don't** bypass `registerVoiceRoutes()` with raw websocket handlers.
- **Don't** put business logic in transport/provider code when it belongs in `brain.run`.
- **Don't** omit `access`.
- **Don't** reimplement a provider when a session fails with `voice.provider_package_missing` — install the add-on named in `installPackage`.
- **Don't** add `minChunkChars` — that is not a `defineVoice` setting (see [`continuous-sessions.md`](./continuous-sessions.md)).
- **Don't** invent a local “mm-hmm” TTS path — set `stt.options.backchannelEnabled` and `backchannelPhrases`.

## Deeper reference

- `/docs/voice/defining-voices.md`
- `/docs/voice/transports.md`
- `/docs/voice/livekit-continuous-voice.md`
- [`continuous-sessions.md`](./continuous-sessions.md)
