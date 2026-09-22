import type { ApiManifest } from './types.js';

/** API version label shared by runtime, OpenAPI, and docs generators. */
export function apiVersionFromManifest(manifest: ApiManifest): string {
  const match = manifest.basePath.match(/\/v(\d+)/);
  return match ? `v${match[1]}` : 'v1';
}

/** Join manifest base path and route path without collapsing slashes inside segments. */
export function joinApiPath(basePath: string, routePath: string): string {
  if (!basePath.startsWith('/')) {
    throw new Error(`API basePath must start with "/": ${basePath}`);
  }
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const route = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${base}${route}`;
}
