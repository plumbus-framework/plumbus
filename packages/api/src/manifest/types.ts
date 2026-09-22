import type { ApiExposureConfig } from '@plumbus/core';
import type { ApiPolicy } from '../policy/types.js';
import type { SecurityScheme } from './schema.js';

export type { SecurityScheme };

export interface ApiManifestEntry extends Omit<ApiExposureConfig, 'auth'> {
  /** Capability reference as `<domain>.<name>` */
  capability: string;
  auth?: {
    scheme?: string | readonly string[];
    scopes?: readonly string[];
  };
}

export interface ApiManifest {
  apiVersion: string;
  name: string;
  basePath: string;
  identity?: {
    audience?: string;
    /** @deprecated Use defaultSecurityScheme */
    defaultAuth?: string;
    defaultSecurityScheme?: string;
  };
  securitySchemes?: Record<string, SecurityScheme>;
  policy?: ApiPolicy;
  expose: ApiManifestEntry[];
}

export interface ApiManifestFinding {
  code: string;
  message: string;
  severity?: 'error' | 'warning';
  capability?: string;
  operationId?: string;
  path?: string;
}
