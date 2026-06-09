import type { ApiExposureConfig } from '@plumbus/core';
import type { ApiPolicy } from '../policy/types.js';

export interface ApiManifestEntry extends ApiExposureConfig {
  /** Capability reference as `<domain>.<name>` */
  capability: string;
}

export interface ApiManifest {
  apiVersion: string;
  name: string;
  basePath: string;
  identity?: {
    audience?: string;
    defaultAuth?: string;
  };
  policy?: ApiPolicy;
  expose: ApiManifestEntry[];
}

export interface ApiManifestFinding {
  code: string;
  message: string;
  capability?: string;
  operationId?: string;
  path?: string;
}
