# Defining a Voice — Agent Recipe

Use this when the user asks to add a new voice surface.

## Minimal recipe

1. Declare one `defineVoice({...})` config.
2. Include `access`.
3. Pick one transport, one STT provider, and one TTS provider.
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
- `resolveTone(ctx, args)` chooses the tone profile per turn.
- `preprocessForTts(text, ctx)` can normalize or annotate output before TTS.
- For Soniox STT, set `stt.options.contextTerms` to send `context.terms` for domain vocabulary.

Use the hooks for delivery behavior, not for app business logic.

## Don'ts

- **Don't** bypass `registerVoiceRoutes()` with raw websocket handlers.
- **Don't** put business logic in transport/provider code when it belongs in `brain.run`.
- **Don't** omit `access`.

## Deeper reference

- `/docs/voice/defining-voices.md`
- `/docs/voice/transports.md`
