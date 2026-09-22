const LANG_PATTERN = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/;

export function buildHostedLoginParams(
  hostedLogin:
    | {
        allowedIdentityProviders?: readonly string[];
        defaultIdentityProvider?: string;
        allowLangHint?: boolean;
      }
    | undefined,
  input: Readonly<Record<string, string>>,
): { ok: true; params: Readonly<Record<string, string>> } | { ok: false; reason: string } {
  const params: Record<string, string> = {};
  const allowlist = hostedLogin?.allowedIdentityProviders;

  for (const key of Object.keys(input)) {
    if (key === 'identity_provider') {
      const value = input.identity_provider;
      if (!value) return { ok: false, reason: 'identity_provider must be non-empty' };
      if (!allowlist) return { ok: false, reason: 'identity_provider is not configured' };
      if (!allowlist.includes(value))
        return { ok: false, reason: 'identity_provider is not allowlisted' };
      params.identity_provider = value;
      continue;
    }
    if (key === 'lang') {
      if (!hostedLogin?.allowLangHint) return { ok: false, reason: 'lang hint is not enabled' };
      const value = input.lang;
      if (!value || !LANG_PATTERN.test(value)) return { ok: false, reason: 'invalid lang hint' };
      params.lang = value;
      continue;
    }
    return { ok: false, reason: `unsupported parameter: ${key}` };
  }

  if (!params.identity_provider && hostedLogin?.defaultIdentityProvider) {
    params.identity_provider = hostedLogin.defaultIdentityProvider;
  }

  const serialized = new URLSearchParams(params).toString();
  if (Buffer.byteLength(serialized, 'utf8') > 512) {
    return { ok: false, reason: 'serialized hosted-login params exceed 512 bytes' };
  }

  return { ok: true, params };
}
