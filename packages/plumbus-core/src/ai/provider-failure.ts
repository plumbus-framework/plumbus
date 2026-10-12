// ── Provider failures that cost nothing ──
// Decides whether a failed provider attempt can have been billed. The AI service records an
// attempt that never reached the provider, or that the provider turned away, as zero spend;
// every other failure is charged a conservative estimate so dollar budgets stay enforced.

/** Node syscalls that fail before a request byte is written: name resolution and TCP connect. */
const PRE_REQUEST_SYSCALLS = new Set([
  'getaddrinfo',
  'getnameinfo',
  'connect',
  'queryA',
  'queryAaaa',
]);

/** Codes raised while resolving the host, opening the connection or negotiating TLS. */
const PRE_REQUEST_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
  // Node's fetch (undici): the connection did not open within its connect timeout.
  'UND_ERR_CONNECT_TIMEOUT',
  // TLS handshake failures: the HTTP request is only written once the handshake completes.
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'HOSTNAME_MISMATCH',
]);

/** Local request validation thrown by the built-in adapters before any provider I/O. */
const PRE_REQUEST_ERROR_NAMES = new Set(['AIInvalidRequestError']);

/**
 * 4xx answers that can follow work the model already did, so they are not free: a model that
 * ran past its timeout (408, Bedrock's `ModelTimeoutException`) and a model that failed while
 * processing or streaming (424, Bedrock's `ModelErrorException` / `ModelStreamErrorException`).
 */
const POSSIBLY_BILLED_CLIENT_STATUSES = new Set([408, 424]);

// `fetch failed` wraps the socket error in `cause`; a short walk is enough for every adapter.
const MAX_CAUSE_DEPTH = 5;

function readProperty(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

/**
 * HTTP status of an error response, from the shapes adapters throw: `statusCode`
 * (`ProviderAPIError`), `status` (vendor SDK API errors) and `$metadata.httpStatusCode`
 * (AWS SDK exceptions).
 */
function httpStatus(error: object): number | undefined {
  const metadata = readProperty(error, '$metadata');
  const candidates = [
    readProperty(error, 'statusCode'),
    readProperty(error, 'status'),
    typeof metadata === 'object' && metadata !== null
      ? readProperty(metadata, 'httpStatusCode')
      : undefined,
  ];
  return candidates.find((value): value is number => typeof value === 'number');
}

function isPreRequestError(error: object): boolean {
  const code = readProperty(error, 'code');
  if (typeof code === 'string' && PRE_REQUEST_CODES.has(code)) return true;
  const syscall = readProperty(error, 'syscall');
  if (typeof syscall === 'string' && PRE_REQUEST_SYSCALLS.has(syscall)) return true;
  const name = readProperty(error, 'name');
  if (typeof name === 'string' && PRE_REQUEST_ERROR_NAMES.has(name)) return true;
  // A 4xx is the provider declining the request (auth, rate limit, invalid or oversized
  // input): no completion ran. A 5xx stays unknown — the work may have run before it failed.
  const status = httpStatus(error);
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    !POSSIBLY_BILLED_CLIENT_STATUSES.has(status)
  );
}

/**
 * True when a failed provider attempt cannot have been billed: the host did not resolve, the
 * connection or TLS handshake never completed, the adapter rejected the request locally, or
 * the provider declined it with a 4xx. Anything else (a dropped connection, a read timeout, a
 * 5xx, a 408/424 model timeout or model error, an unrecognised error) may have been billed and
 * is not cost-free.
 */
export function isCostFreeProviderFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if (isPreRequestError(current)) return true;
    // Happy-eyeballs connects report one failure per address in an AggregateError.
    const errors = readProperty(current, 'errors');
    if (
      Array.isArray(errors) &&
      errors.length > 0 &&
      errors.every((inner) => isCostFreeProviderFailure(inner))
    ) {
      return true;
    }
    current = readProperty(current, 'cause');
  }
  return false;
}
