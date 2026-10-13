# Uploaded-file transcription

Use `@plumbus/voice/transcription` (0.6.0-beta.2+) and an explicit
`FileTranscriptionProviderRegistration` from a vendor add-on. Soniox's registration is
`SONIOX_FILE_TRANSCRIPTION_REGISTRATION` from `@plumbus/voice-soniox` 0.3.0-beta.2+.
Do not install or import the vendor SDK in an application.

`createFileTranscriptionRuntime({ registration, credentials, config })` takes a server-owned
model, explicit region, `maxInputBytes`, `maxOutputBytes`, optional `languageHints`, `maxTokens`,
`maxPages`, `pageSize` and `timeoutMs`. Soniox accepts explicit `us`, `eu`, `jp`; a server-only
`baseUrl` overrides that derived endpoint. `SONIOX_API_KEY`/`SONIOX_BASE_URL` use the add-on's
existing `resolveCredentialsFromEnv()`. Keep keys and raw provider payloads server-side.

Call short methods from authorized Plumbus capabilities/flows:

- `upload(ctx, { bytes, byteLength, contentType, uploadReference }, options)`
- `reconcileUpload(ctx, { uploadReference, byteLength, createdAfter, createdBefore }, options)`
- `submit(ctx, { fileId, clientReference }, options)`
- `reconcileSubmission(ctx, { fileId, clientReference, createdAfter, createdBefore }, options)`
- `getJob(ctx, { jobId }, options)` and `getTranscript(ctx, { jobId }, options)`
- `getUsage(ctx, { jobId, clientReference, startedAfter, endedBefore }, options)`
- `deleteJob(ctx, { jobId }, options)` and `deleteFile(ctx, { fileId }, options)`

`options` carries `signal` and the required internal `estimatedCostUsd` for upload/submit.
These two methods check the invoking `ctx.ai` budget. The application still owns atomic budget
reservations, inspected inputs, rights, scope and exact-target adoption through `ctx.*`.
Use entity/flow state for durable references and retry scheduling; do not create a parallel
queue, job or worker. Do not store file bytes, transcription text or credentials in flow state.

Persist attempts before external writes. Unknown upload/submit outcomes must reconcile;
client references are not provider idempotency keys. Zero/ambiguous/incomplete scans remain
unknown and must not resubmit paid work. Input is bounded and buffered; do not promise constant
memory streaming. All operations inherit cancellation and a bounded total timeout.

Persist output before cleanup. Processing-delete409 remains pending. Do not remove the file
while its job processes. Keep unresolved cleanup references and retry through the flow.

`recordFileTranscriptionCost(ctx, { provider, model, usage, pricing?, latencyMs, costContext?,
status? })` records actual aggregate tokens and audio duration using `ctx.ai.recordProviderCost`.
It returns nullable cost and the split `usage`, including optional `providerUsageId`; persist
these through the tenant ledger adapter. Rates are `inputAudioUsdPerMillion`,
`inputTextUsdPerMillion`, `outputTextUsdPerMillion`. Measured provider cost wins. Unknown
usage/pricing remains null, never free. Soniox successful usage logs may arrive later; failed
requests can remain unresolved. Never release a hold solely because a bill is absent or a
30-minute text reservation expired. Application settlement must be once per job.

Do not add fake prompt names, use realtime per-hour estimates as final billing, bypass source
rights or call live providers from automated tests. Test the official SDK against fake HTTP.

### Billing after provider cleanup

Before deleting a terminal job, persist its sanitized `getJob` response on the server. Subsequent
`getUsage` calls may pass this `verifiedJob` receipt together with the original persisted `fileId`.
The adapter validates the exact job/file/model/reference, terminal status and bounded UTC window.
A live job is cross-checked when present; only a genuine not-found response permits the recorded
receipt to stand in after deletion. The measured usage log still must match uniquely. Missing or
ambiguous usage stays unknown and keeps the application's hold. This receipt is trusted durable
application state, never an authorization assertion accepted from a browser or public API.
