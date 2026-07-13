// ── API Module ──
// HTTP route generation: registers Fastify routes for capabilities.
// Maps capability kind to HTTP method (query→GET, action/job→POST).
//
// Key exports: registerAllRoutes, registerCapabilityRoute, isApiExposed

export { isApiExposed } from './exposure.js';
export {
  LOCALE_COOKIE_NAME,
  registerAllRoutes,
  registerCapabilityRoute,
  registerStreamingRoute,
  resolveRequestLocale,
} from './route-generator.js';
export type {
  DependencyOptions,
  ResolveRequestLocaleOptions,
  RouteGeneratorConfig,
} from './route-generator.js';
