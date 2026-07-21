import type { FastifyInstance } from 'fastify';
import type { RequestAuthenticator } from '../auth/http-authentication.js';

export interface AuthComponentHealth {
  status: 'ok' | 'degraded';
  providers?: Record<string, 'available' | 'unavailable'>;
}

export interface HttpAuthenticationRuntime {
  authenticator: RequestAuthenticator;
  initialize(): Promise<void>;
  registerRoutes(app: FastifyInstance): void | Promise<void>;
  close?(): Promise<void>;
  describeHealth?(): AuthComponentHealth;
}
