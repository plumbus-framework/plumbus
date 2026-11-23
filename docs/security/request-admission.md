# Request admission before capability side effects

`@plumbus/core/admission` provides `createRequestAdmission` and `withRequestAdmissionLock`.
The capability owns when work is required and how to respond. Admission is not authentication
and must never replace tenant binding, access checks, mailbox possession or device binding.

A server creates a signed, short-lived work challenge bound to an opaque application context
(e.g. tenant, recipient pseudonym and request-source signal). The bundled
`@plumbus/core/admission/client` solver uses pinned SHA-256 code, yields cooperatively, supports
cancellation and limits difficulty/time. The solver reuses the invariant SHA-256 prefix and yields cooperatively; its time budget is monotonic.
Ticket expiry is checked on the server; a skewed browser clock does not reject a valid challenge.
No remote code, service credentials, network call or
persistent browser storage is needed. Work makes automation costlier; it does not prove humanity
and cannot guarantee availability against an attacker willing to perform the same work.

`verify` returns a digest of the challenge token. The application must persist that digest under
a unique constraint in the same transaction as the admitted action. Verification alone is not
single-use. Never store/log the challenge token or solution. Reject expired, forged, wrong-binding
and already-consumed work. Short recipient cooldowns can bound delivery without a long account
lockout; quotas, work thresholds and retry presentation are application policy.

`withRequestAdmissionLock(db, key, work)` opens a database transaction and an advisory lock
scoped to an opaque application key. Read counters and write the admitted record through
Plumbus repositories on the supplied transaction. Independent workers sharing the same database
then serialize the check and write. Keep external work (including mail delivery) outside this lock.

Options (core 0.9.0-beta.15+), as a fourth argument:

- `mode: 'shared'` — any number of shared holders of the key run together; they wait for, and
  are waited for by, exclusive holders of the same key (`pg_advisory_xact_lock_shared` on the
  same lock id). For work that only has to keep a rare exclusive operation out — publications
  that must not overlap a cutover, per-record writes that must not overlap a purge — take the key
  shared there and exclusive in the rare operation. The default stays `'exclusive'`.
- `lockTimeoutMs` — wait at most this long for the lock, then fail with
  `RequestAdmissionLockTimeoutError` (`reason: 'admission-lock-timeout'`, HTTP 503). It applies
  to taking the lock only; the transaction's own `lock_timeout` is restored once it is held.
  Without it the wait is the session's `lock_timeout` (normally unbounded), and every waiter holds
  a pool connection while it waits.

Transport source addresses come from the configured trusted proxy chain. An IP is a network
signal, not an authenticated individual; a shared gateway must not produce permanent account
lockouts. Do not trust caller-selected source headers or use source addresses as tenant authority.

See [execution lifecycle](../architecture/execution-lifecycle.md) and
[data layer](../sdk-reference/data-layer.md).
