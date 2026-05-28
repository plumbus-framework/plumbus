/** Extract Bearer token from Authorization header value. */
export function parseBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }
  if (authorizationHeader.startsWith('Bearer ')) {
    return authorizationHeader.slice(7).trim() || null;
  }
  return null;
}
