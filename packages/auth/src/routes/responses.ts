export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

export function errorRedirectUrl(
  errorPath: string,
  code: string,
  requestId: string,
  returnTo?: { param: string; path: string },
): string {
  const url = new URL(errorPath, 'http://local');
  url.searchParams.set('code', code);
  url.searchParams.set('requestId', requestId);
  if (returnTo) {
    url.searchParams.set(returnTo.param, returnTo.path);
  }
  return `${url.pathname}${url.search}`;
}

const CALLBACK_RETURN_TO = Symbol.for('plumbus.auth.callbackReturnTo');

/**
 * Tags a failed callback's error with the login's validated `returnTo`, so the error redirect can
 * carry it when `errorReturnToParam` is configured. Non-Error values are wrapped.
 */
export function withCallbackReturnTo(error: unknown, returnTo: string): Error {
  const tagged = error instanceof Error ? error : new Error('login_failed');
  Object.defineProperty(tagged, CALLBACK_RETURN_TO, { value: returnTo, configurable: true });
  return tagged;
}

/** The `returnTo` a failed callback recovered from its login transaction, when it had one. */
export function callbackReturnTo(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const value = (error as unknown as Record<symbol, unknown>)[CALLBACK_RETURN_TO];
  return typeof value === 'string' ? value : undefined;
}

export function mapCallbackError(error: unknown): string {
  if (!(error instanceof Error)) return 'login_failed';
  switch (error.message) {
    case 'login_cancelled':
      return 'login_cancelled';
    case 'provider_unavailable':
      return 'provider_unavailable';
    case 'login_denied':
      return 'login_failed';
    default:
      return 'login_failed';
  }
}
