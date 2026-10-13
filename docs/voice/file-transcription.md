# File transcription

`@plumbus/voice` 0.6.0-beta.2 adds short, server-only file operations under
`@plumbus/voice/transcription`. `@plumbus/voice-soniox` 0.3.0-beta.2 supplies
`SONIOX_FILE_TRANSCRIPTION_REGISTRATION` using the existing official Soniox SDK.
These versions are locally staged; package publication is a separate action.
Realtime sessions and their provider contracts are unchanged.

The application owns durable state through Plumbus capabilities, entities, events and
flows. This helper does not create routes, sessions, timers, queues or a second worker.
A provider registration is an explicit dependency, not an automatically discovered LLM.

```ts
import { createFileTranscriptionRuntime, recordFileTranscriptionCost } from '@plumbus/voice/transcription';
import { SONIOX_FILE_TRANSCRIPTION_REGISTRATION, resolveCredentialsFromEnv } from '@plumbus/voice-soniox';

const transcription = createFileTranscriptionRuntime({
  registration: SONIOX_FILE_TRANSCRIPTION_REGISTRATION,
  credentials: resolveCredentialsFromEnv(),
  config: {
    model: 'stt-async-v5',
    region: 'eu', // Example only: choose the authorized deployment region explicitly.
    maxInputBytes: 100 * 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
    languageHints: ['he', 'en'],
    maxPages: 10,
    pageSize: 100,
    timeoutMs: 30_000,
  },
});

// Inside an authorized capability/flow step, AFTER a durable attempt and atomic reservation:
const uploaded = await transcription.upload(ctx, {
  bytes: admittedPrivateAssetStream,
  byteLength: inspectedByteLength,
  contentType: 'video/mp4',
  uploadReference: persistedRandomUploadReference,
}, { estimatedCostUsd: reservedAmount, signal: ctx.signal });
```

The example variables are application-owned inspected facts. Never trust browser duration,
rights, source URLs, model selection, credentials or claimed budget authorization. A runtime
accepts the invoking `ctx` and combines its abort signal with any explicit signal. Upload and
submit require a finite nonnegative internal estimate and call `ctx.ai.checkProviderCostBudget`.
That check supplements, but does not replace, the application's atomic durable reservation.
Identity-aware tenant billing must use the same invoking context, not a boot-time global ledger.
Explicit zero is valid only for genuinely free configured processing.

## Operations and recovery

| Method | Input/result |
| --- | --- |
| `upload(ctx, input, options)` | Bounded bytes or async byte chunks, exact byte length, MIME type and opaque random upload reference. Returns `uploaded` with file ID or `unknown`. |
| `reconcileUpload` | Exact opaque reference, size and UTC creation window. Adopts a single matching file only after finishing a bounded scan. |
| `submit` | File ID and a distinct persisted opaque job reference. Model/languages come from server configuration. Returns `submitted` or `unknown`. |
| `reconcileSubmission` | Exact file, model, reference and UTC creation window. Zero, multiple, or incomplete results remain unknown. |
| `getJob` | One read, returning a sanitized job or null for not found; no internal polling. |
| `getTranscript` | One read, returning verbatim text and millisecond token times with optional language, confidence and speaker. Invalid or excessive output fails instead of truncating. |
| `getUsage` | Bounded usage-log scan in a UTC completion-time window; authoritative job read and unique reference/model/window correlation (billing UUIDs need not equal job IDs). Returns actual audio duration, audio-input/text-input/text-output tokens and nullable provider cost, or unknown. |
| `deleteJob`, `deleteFile` | Separate operations: success/404 is `deleted`, 409 is `pending`, other failures throw sanitized structured errors. |

Persist the attempt **before** each external side effect. Neither `client_reference_id` nor
an upload filename is an idempotency guarantee. If upload or submit times out, receives an
uncertain server error, or returns an invalid success response, keep the outcome unknown.
Do not automatically submit again. Reconciliation considers all bounded pages, deduplicates
identical IDs and refuses ambiguity or a page limit. Retain unresolved upload references for
operator investigation and cleanup; never delete unrelated files from a shared provider project.
An abort after sending can also have an unknown outcome. Pre-aborted work makes no request.

Buffers are bounded by the configured input size before upload; the SDK itself buffers input,
so accepting an async byte source does not promise a constant-memory multipart transfer.
Responses are bounded before the SDK parses JSON. Token counts, UTF-8 text bytes, page counts,
page sizes and request timeouts are bounded. Recovery windows are limited to seven days per
operation; schedule narrower windows in durable steps if longer recovery is needed.

The Soniox adapter requires an explicit `us`, `eu` or `jp` region. A configured server-only
`SONIOX_BASE_URL` overrides the derived REST endpoint, so operators must validate its residency.
The adapter supplies the chosen URL explicitly, preventing unrelated Soniox SDK environment
fallbacks from silently moving traffic. It refuses credential-bearing URLs and redirects.
It uses no webhook or translation; language hints are non-strict.

Save outputs durably before deletion. Keep the uploaded file until the job reaches completed
or failed. A processing job cannot be deleted; local discard means no adoption, then eventual
cleanup through the app flow. A failed delete is not completed cleanup. No raw provider error,
file contents, transcript, original filename or credentials belongs in logs or flow state.

## Exact usage and billing

`recordFileTranscriptionCost(ctx, { provider, model, usage, pricing?, latencyMs, costContext?,
status? })` records a `transcribe` operation through `ctx.ai.recordProviderCost`. It sends actual
aggregate input/output tokens and measured audio seconds. It returns `{ cost, pricingKnown,
usage }`; retain the audio/text input split in the application's transcription request and
ledger adapter. Existing core token fields stay unchanged. Do not fabricate a prompt name.

A known provider bill takes precedence, including a measured zero. Otherwise three configured
rates (`inputAudioUsdPerMillion`, `inputTextUsdPerMillion`, `outputTextUsdPerMillion`) calculate
the cost from the measured token quantities. Missing usage or missing prices stays `null`.
Duration-based estimates do not become final billed costs. Missing measured usage records an
incomplete unknown row; zero token placeholders in that legacy core shape are not measured free
usage. Persist the returned unknown state and keep the reservation unsettled.

The helper records one call; the application owns exactly-once settlement per provider job and
must not call it twice after retries. Soniox usage logs can arrive later and only contain
successful completed requests. Failed/uncertain jobs therefore need retained holds and explicit
operator reconciliation, not automatic zero settlement or release on a timeout.

## Validation

Tests exercise the official SDK through a fake HTTP transport: mixed Hebrew/English, timing,
silence, size limits, POST uncertainty, exact bounded reconciliation, actual token splits,
unknown bills, cancellation, redaction and processing-delete 409. Runtime tests verify invoking
context budget checks and ledger accounting. No paid call is required by this test suite.

See [cost tracking](cost-tracking.md), [security](security.md), [testing](testing.md), and the
[Soniox async API](https://soniox.com/docs/stt/async/async-transcription),
[usage logs](https://soniox.com/docs/guides/usage-logs) and
[API errors](https://soniox.com/docs/api-reference/errors).

### Billing after provider cleanup

Before deleting a terminal job, persist its sanitized `getJob` response on the server. Subsequent
`getUsage` calls may pass this `verifiedJob` receipt together with the original persisted `fileId`.
The adapter validates the exact job/file/model/reference, terminal status and bounded UTC window.
A live job is cross-checked when present; only a genuine not-found response permits the recorded
receipt to stand in after deletion. The measured usage log still must match uniquely. Missing or
ambiguous usage stays unknown and keeps the application's hold. This receipt is trusted durable
application state, never an authorization assertion accepted from a browser or public API.
