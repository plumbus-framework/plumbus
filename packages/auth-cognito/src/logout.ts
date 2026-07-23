export function buildCognitoLogoutUrl(
  configuredDomain: string | undefined,
  input: { metadata: { endSessionEndpoint?: string }; clientId: string; logoutUri: string },
): URL | null {
  let origin: string | undefined;
  if (input.metadata.endSessionEndpoint) {
    try {
      origin = new URL(input.metadata.endSessionEndpoint).origin;
    } catch {
      return null;
    }
  } else if (configuredDomain) {
    try {
      origin = new URL(configuredDomain).origin;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (!origin.startsWith('https://')) {
    return null;
  }

  const url = new URL('/logout', origin);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('logout_uri', input.logoutUri);
  return url;
}
