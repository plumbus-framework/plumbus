const MULTI_PART_TLDS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

function registrableSuffix(host: string): string {
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) {
    return host;
  }
  const tld = labels[labels.length - 1] ?? '';
  const sld = labels[labels.length - 2] ?? '';
  if (tld.length === 2 && MULTI_PART_TLDS.has(sld) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

export function assertSameSiteDeployment(
  applicationBaseUrl: string | URL,
  externalBaseUrl: string | URL,
  opts?: { assumeSameSite?: boolean },
): void {
  const app =
    typeof applicationBaseUrl === 'string' ? new URL(applicationBaseUrl) : applicationBaseUrl;
  const ext = typeof externalBaseUrl === 'string' ? new URL(externalBaseUrl) : externalBaseUrl;

  if (app.origin === ext.origin) {
    return;
  }

  const appHost = app.hostname.toLowerCase();
  const extHost = ext.hostname.toLowerCase();
  if (appHost === extHost) {
    return;
  }

  if (registrableSuffix(appHost) === registrableSuffix(extHost)) {
    return;
  }

  if (opts?.assumeSameSite) {
    return;
  }

  throw new Error(
    `applicationBaseUrl (${app.origin}) and externalBaseUrl (${ext.origin}) are not same-site; use bearer transport or set deployment.assumeSameSite`,
  );
}
