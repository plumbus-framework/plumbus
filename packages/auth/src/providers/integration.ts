export interface OidcProviderIntegration {
  id: string;
  authorizationParams?(
    options: Readonly<Record<string, string>>,
  ): { ok: true; params: Readonly<Record<string, string>> } | { ok: false; reason: string };
  selectClientAuthMethod?(
    advertised: readonly string[],
  ): 'client_secret_basic' | 'client_secret_post' | undefined;
  buildProviderLogoutUrl?(input: {
    metadata: { endSessionEndpoint?: string };
    clientId: string;
    logoutUri: string;
  }): URL | null;
  validateRegistration?(reg: {
    issuer: string;
    scopes: readonly string[];
    fetchUserInfo?: boolean;
    providerLogout?: { returnTo: string };
  }): readonly string[];
}
