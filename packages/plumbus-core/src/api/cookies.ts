export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }

  const cookies: Record<string, string> = Object.create(null);
  const duplicates = new Set<string>();

  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      continue;
    }

    const name = trimmed.slice(0, eq).trim();
    if (!name) {
      continue;
    }

    if (duplicates.has(name)) continue;
    if (Object.hasOwn(cookies, name)) {
      delete cookies[name];
      duplicates.add(name);
      continue;
    }

    const rawValue = trimmed.slice(eq + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }

  return cookies;
}
