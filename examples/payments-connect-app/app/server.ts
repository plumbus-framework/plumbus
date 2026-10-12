// Mounts the payments webhook route (POST /payments/webhooks/stripe).
import { registerPaymentRoutes } from '@plumbus/payments';
import { payments } from './payments/index.js';

type RouteArgs = Parameters<typeof registerPaymentRoutes>;

export function onRoutesRegistered(app: RouteArgs[0], routeConfig: RouteArgs[1]) {
  registerPaymentRoutes(app, routeConfig, payments);
}
