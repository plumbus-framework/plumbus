export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

export function errorRedirectUrl(errorPath: string, code: string, requestId: string): string {
  const url = new URL(errorPath, 'http://local');
  url.searchParams.set('code', code);
  url.searchParams.set('requestId', requestId);
  return `${url.pathname}${url.search}`;
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
