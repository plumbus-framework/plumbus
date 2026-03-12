import type { PolicyProfile } from './enums.js';

// ── Database Config ──
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  poolSize?: number;
}

// ── Queue Config ──
export interface QueueConfig {
  host: string;
  port: number;
  password?: string;
  prefix?: string;
}

// ── AI Provider Config ──
export interface AIProviderConfig {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokensPerRequest?: number;
  dailyCostLimit?: number;
}

// ── Auth Adapter Config ──
export interface AuthAdapterConfig {
  provider: string;
  issuer?: string;
  audience?: string;
  jwksUri?: string;
  secret?: string;
}

// ── Environment ──
export type Environment = 'development' | 'staging' | 'production';

// ── Plumbus Config ──
export interface PlumbusConfig {
  environment: Environment;
  database: DatabaseConfig;
  queue: QueueConfig;
  ai?: AIProviderConfig;
  auth: AuthAdapterConfig;
  complianceProfiles?: (PolicyProfile | string)[];
}
