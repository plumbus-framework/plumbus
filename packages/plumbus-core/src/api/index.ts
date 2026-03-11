// ── API Module ──
// HTTP route generation: registers Fastify routes for capabilities.
// Maps capability kind to HTTP method (query→GET, action/job→POST).
//
// Key exports: registerAllRoutes, registerCapabilityRoute

export {
  registerAllRoutes,
  registerCapabilityRoute,
} from './route-generator.js';
export type { RouteGeneratorConfig } from './route-generator.js';
