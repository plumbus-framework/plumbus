export interface ApiPolicy {
  tenantRouting?: {
    mode: 'auth-context' | 'path-prefix';
    forbidExplicitTenantInput?: boolean;
    forbiddenParams?: { path?: string[]; query?: string[]; body?: string[] };
    prefix?: string;
    paramName?: string;
  };
  methodSemantics?: {
    forbidMutationOverGet?: boolean;
    forbidGetBody?: boolean;
  };
}
