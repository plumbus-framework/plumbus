import { describe, expect, it } from 'vitest';
import type { PlumbusConfig } from '../../types/config.js';
import { loadConfig, loadPromptOverrides, validateConfig } from '../loader.js';

// ── Tests ──

describe('Config Loader', () => {
  describe('loadConfig', () => {
    it('loads config with development defaults when no env vars set', () => {
      const config = loadConfig({ env: {} });
      expect(config.environment).toBe('development');
      expect(config.database.host).toBe('localhost');
      expect(config.database.port).toBe(5432);
      expect(config.database.database).toBe('plumbus_dev');
      expect(config.database.user).toBe('postgres');
      expect(config.database.password).toBe('postgres');
      expect(config.database.poolSize).toBe(5);
    });

    it('uses PLUMBUS_ENV for environment', () => {
      const config = loadConfig({ env: { PLUMBUS_ENV: 'staging' } });
      expect(config.environment).toBe('staging');
    });

    it('falls back to NODE_ENV when PLUMBUS_ENV is not set', () => {
      const config = loadConfig({ env: { NODE_ENV: 'production' } });
      expect(config.environment).toBe('production');
    });

    it('prefers PLUMBUS_ENV over NODE_ENV', () => {
      const config = loadConfig({
        env: { PLUMBUS_ENV: 'staging', NODE_ENV: 'production' },
      });
      expect(config.environment).toBe('staging');
    });

    it('allows environment override via options', () => {
      const config = loadConfig({
        environment: 'production',
        env: { PLUMBUS_ENV: 'development' },
      });
      expect(config.environment).toBe('production');
    });

    it('reads database config from env vars', () => {
      const config = loadConfig({
        env: {
          DATABASE_HOST: 'db.example.com',
          DATABASE_PORT: '5433',
          DATABASE_NAME: 'mydb',
          DATABASE_USER: 'admin',
          DATABASE_PASSWORD: 'secret123',
          DATABASE_SSL: 'true',
          DATABASE_POOL_SIZE: '10',
        },
      });
      expect(config.database.host).toBe('db.example.com');
      expect(config.database.port).toBe(5433);
      expect(config.database.database).toBe('mydb');
      expect(config.database.user).toBe('admin');
      expect(config.database.password).toBe('secret123');
      expect(config.database.ssl).toBe(true);
      expect(config.database.poolSize).toBe(10);
    });

    it('supports PG* env var aliases', () => {
      const config = loadConfig({
        env: {
          PGHOST: 'pg.example.com',
          PGPORT: '5434',
          PGDATABASE: 'pgdb',
          PGUSER: 'pgadmin',
          PGPASSWORD: 'pgpass',
        },
      });
      expect(config.database.host).toBe('pg.example.com');
      expect(config.database.port).toBe(5434);
      expect(config.database.database).toBe('pgdb');
      expect(config.database.user).toBe('pgadmin');
      expect(config.database.password).toBe('pgpass');
    });

    it('prefers DATABASE_* over PG* aliases', () => {
      const config = loadConfig({
        env: {
          DATABASE_HOST: 'primary',
          PGHOST: 'secondary',
        },
      });
      expect(config.database.host).toBe('primary');
    });

    it('supports DB_* env var aliases (scaffold-generated)', () => {
      const config = loadConfig({
        env: {
          DB_HOST: 'db.scaffold.com',
          DB_PORT: '5435',
          DB_NAME: 'scaffold_db',
          DB_USER: 'scaffolduser',
          DB_PASSWORD: 'scaffoldpass',
        },
      });
      expect(config.database.host).toBe('db.scaffold.com');
      expect(config.database.port).toBe(5435);
      expect(config.database.database).toBe('scaffold_db');
      expect(config.database.user).toBe('scaffolduser');
      expect(config.database.password).toBe('scaffoldpass');
    });

    it('prefers DATABASE_* over DB_* aliases', () => {
      const config = loadConfig({
        env: {
          DATABASE_HOST: 'full-form',
          DB_HOST: 'short-form',
        },
      });
      expect(config.database.host).toBe('full-form');
    });

    it('enables SSL in production by default', () => {
      const config = loadConfig({
        environment: 'production',
        env: {},
      });
      expect(config.database.ssl).toBe(true);
    });

    it('uses larger pool size in production', () => {
      const config = loadConfig({
        environment: 'production',
        env: {},
      });
      expect(config.database.poolSize).toBe(20);
    });

    it('reads queue config from env vars', () => {
      const config = loadConfig({
        env: {
          QUEUE_HOST: 'redis.example.com',
          QUEUE_PORT: '6380',
          QUEUE_PASSWORD: 'redispass',
          QUEUE_PREFIX: 'myapp:',
        },
      });
      expect(config.queue.host).toBe('redis.example.com');
      expect(config.queue.port).toBe(6380);
      expect(config.queue.password).toBe('redispass');
      expect(config.queue.prefix).toBe('myapp:');
    });

    it('supports REDIS_* env var aliases for queue', () => {
      const config = loadConfig({
        env: {
          REDIS_HOST: 'redis2.example.com',
          REDIS_PORT: '6381',
          REDIS_PASSWORD: 'redispass2',
        },
      });
      expect(config.queue.host).toBe('redis2.example.com');
      expect(config.queue.port).toBe(6381);
      expect(config.queue.password).toBe('redispass2');
    });

    it('defaults queue prefix to plumbus:{environment}', () => {
      const config = loadConfig({ env: {} });
      expect(config.queue.prefix).toBe('plumbus:development');
    });

    it('returns undefined for AI when no AI env vars set', () => {
      const config = loadConfig({ env: {} });
      expect(config.ai).toBeUndefined();
    });

    it('loads AI config when both provider and apiKey are set', () => {
      const config = loadConfig({
        env: {
          AI_PROVIDER: 'openai',
          AI_API_KEY: 'sk-test',
          AI_MODEL: 'gpt-4',
          AI_BASE_URL: 'https://api.openai.com',
          AI_MAX_TOKENS: '4096',
          AI_DAILY_COST_LIMIT: '10.5',
        },
      });
      expect(config.ai).toBeDefined();
      expect(config.ai?.provider).toBe('openai');
      expect(config.ai?.apiKey).toBe('sk-test');
      expect(config.ai?.model).toBe('gpt-4');
      expect(config.ai?.baseUrl).toBe('https://api.openai.com');
      expect(config.ai?.maxTokensPerRequest).toBe(4096);
      expect(config.ai?.dailyCostLimit).toBe(10.5);
    });

    it('returns undefined for AI when only provider set (no key)', () => {
      const config = loadConfig({ env: { AI_PROVIDER: 'openai' } });
      expect(config.ai).toBeUndefined();
    });

    it('reads auth config from env vars', () => {
      const config = loadConfig({
        env: {
          AUTH_PROVIDER: 'auth0',
          AUTH_ISSUER: 'https://issuer.example.com',
          AUTH_AUDIENCE: 'https://api.example.com',
          AUTH_JWKS_URI: 'https://issuer.example.com/.well-known/jwks.json',
          AUTH_SECRET: 'my-secret',
        },
      });
      expect(config.auth.provider).toBe('auth0');
      expect(config.auth.issuer).toBe('https://issuer.example.com');
      expect(config.auth.audience).toBe('https://api.example.com');
      expect(config.auth.jwksUri).toBe('https://issuer.example.com/.well-known/jwks.json');
      expect(config.auth.secret).toBe('my-secret');
    });

    it('defaults auth secret to development-secret in dev', () => {
      const config = loadConfig({ env: {} });
      expect(config.auth.secret).toBe('development-secret');
    });

    it('does not default auth secret in production', () => {
      const config = loadConfig({ environment: 'production', env: {} });
      expect(config.auth.secret).toBeUndefined();
    });

    it('parses compliance profiles from comma-separated env var', () => {
      const config = loadConfig({
        env: { PLUMBUS_COMPLIANCE_PROFILES: 'hipaa,gdpr,sox' },
      });
      expect(config.complianceProfiles).toEqual(['hipaa', 'gdpr', 'sox']);
    });

    it('trims whitespace from compliance profiles', () => {
      const config = loadConfig({
        env: { PLUMBUS_COMPLIANCE_PROFILES: ' hipaa , gdpr ' },
      });
      expect(config.complianceProfiles).toEqual(['hipaa', 'gdpr']);
    });

    it('returns undefined compliance profiles when env var not set', () => {
      const config = loadConfig({ env: {} });
      expect(config.complianceProfiles).toBeUndefined();
    });
  });

  describe('validateConfig', () => {
    function makeValidConfig(overrides?: Partial<PlumbusConfig>): PlumbusConfig {
      return {
        environment: 'development',
        database: {
          host: 'localhost',
          port: 5432,
          database: 'plumbus_dev',
          user: 'postgres',
          password: 'postgres',
        },
        queue: { host: 'localhost', port: 6379, prefix: 'plumbus:dev' },
        auth: { provider: 'jwt', secret: 'test-secret' },
        ...overrides,
      };
    }

    it('returns valid for a complete dev config', () => {
      const result = validateConfig(makeValidConfig());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('errors when database host is empty', () => {
      const result = validateConfig(
        makeValidConfig({
          database: { host: '', port: 5432, database: 'db', user: 'u', password: 'p' },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('database.host is required');
    });

    it('errors when database name is empty', () => {
      const result = validateConfig(
        makeValidConfig({
          database: { host: 'h', port: 5432, database: '', user: 'u', password: 'p' },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('database.database is required');
    });

    it('errors when database user is empty', () => {
      const result = validateConfig(
        makeValidConfig({
          database: { host: 'h', port: 5432, database: 'db', user: '', password: 'p' },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('database.user is required');
    });

    it('errors in production when database password is empty', () => {
      const result = validateConfig(
        makeValidConfig({
          environment: 'production',
          database: { host: 'h', port: 5432, database: 'db', user: 'u', password: '', ssl: true },
          auth: { provider: 'jwt', secret: 'prod-secret' },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('database.password is required in production');
    });

    it('warns in production when SSL is disabled', () => {
      const result = validateConfig(
        makeValidConfig({
          environment: 'production',
          database: { host: 'h', port: 5432, database: 'db', user: 'u', password: 'p', ssl: false },
          auth: { provider: 'jwt', secret: 'prod-secret' },
        }),
      );
      expect(result.warnings).toContain('database.ssl should be enabled in production');
    });

    it('errors in production when auth secret is development-secret', () => {
      const result = validateConfig(
        makeValidConfig({
          environment: 'production',
          database: { host: 'h', port: 5432, database: 'db', user: 'u', password: 'p', ssl: true },
          auth: { provider: 'jwt', secret: 'development-secret' },
        }),
      );
      expect(result.errors).toContain('auth.secret must be changed from default in production');
    });

    it('errors in production when no auth secret or jwksUri', () => {
      const result = validateConfig(
        makeValidConfig({
          environment: 'production',
          database: { host: 'h', port: 5432, database: 'db', user: 'u', password: 'p', ssl: true },
          auth: { provider: 'jwt' },
        }),
      );
      expect(result.errors).toContain('auth.secret or auth.jwksUri is required in production');
    });

    it('valid in production with jwksUri and no secret', () => {
      const result = validateConfig(
        makeValidConfig({
          environment: 'production',
          database: { host: 'h', port: 5432, database: 'db', user: 'u', password: 'p', ssl: true },
          auth: { provider: 'auth0', jwksUri: 'https://example.com/.well-known/jwks.json' },
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('errors when AI config has no apiKey', () => {
      const result = validateConfig(
        makeValidConfig({
          ai: { provider: 'openai', apiKey: '' },
        }),
      );
      expect(result.errors).toContain('ai.apiKey is required when AI is configured');
    });

    it('errors when AI config has no provider', () => {
      const result = validateConfig(
        makeValidConfig({
          ai: { provider: '', apiKey: 'sk-test' },
        }),
      );
      expect(result.errors).toContain('ai.provider is required when AI is configured');
    });

    it('valid when AI is not configured (undefined)', () => {
      const result = validateConfig(makeValidConfig());
      expect(result.valid).toBe(true);
    });

    it('returns multiple errors when config has multiple issues', () => {
      const result = validateConfig(
        makeValidConfig({
          environment: 'production',
          database: { host: '', port: 5432, database: '', user: '', password: '', ssl: false },
          auth: { provider: 'jwt', secret: 'development-secret' },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('loadPromptOverrides', () => {
    it('should return undefined when no PROMPT_ env vars exist', () => {
      const result = loadPromptOverrides({});
      expect(result).toBeUndefined();
    });

    it('should parse PROMPT_{NAME}_MODEL env var', () => {
      const result = loadPromptOverrides({
        PROMPT_WRITER_MODEL: 'claude-sonnet-4-20250514',
      });
      expect(result).toEqual({
        writer: { model: 'claude-sonnet-4-20250514' },
      });
    });

    it('should parse PROMPT_{NAME}_PROVIDER env var', () => {
      const result = loadPromptOverrides({
        PROMPT_WRITER_PROVIDER: 'anthropic',
      });
      expect(result).toEqual({
        writer: { provider: 'anthropic' },
      });
    });

    it('should parse PROMPT_{NAME}_TEMPERATURE env var', () => {
      const result = loadPromptOverrides({
        PROMPT_WRITER_TEMPERATURE: '0.7',
      });
      expect(result).toEqual({
        writer: { temperature: 0.7 },
      });
    });

    it('should parse PROMPT_{NAME}_MAX_TOKENS env var', () => {
      const result = loadPromptOverrides({
        PROMPT_WRITER_MAX_TOKENS: '4096',
      });
      expect(result).toEqual({
        writer: { maxTokens: 4096 },
      });
    });

    it('should combine multiple fields for same prompt', () => {
      const result = loadPromptOverrides({
        PROMPT_WRITER_PROVIDER: 'anthropic',
        PROMPT_WRITER_MODEL: 'claude-sonnet-4-20250514',
        PROMPT_WRITER_TEMPERATURE: '0.5',
        PROMPT_WRITER_MAX_TOKENS: '2048',
      });
      expect(result).toEqual({
        writer: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          temperature: 0.5,
          maxTokens: 2048,
        },
      });
    });

    it('should handle multiple prompt overrides', () => {
      const result = loadPromptOverrides({
        PROMPT_WRITER_MODEL: 'gpt-4o',
        PROMPT_ANALYZER_MODEL: 'claude-sonnet-4-20250514',
        PROMPT_ANALYZER_PROVIDER: 'anthropic',
      });
      expect(result).toEqual({
        writer: { model: 'gpt-4o' },
        analyzer: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      });
    });

    it('should handle multi-word prompt names with underscores', () => {
      const result = loadPromptOverrides({
        PROMPT_WRITE_CHAPTER_MODEL: 'gpt-4o-mini',
      });
      expect(result).toEqual({
        write_chapter: { model: 'gpt-4o-mini' },
      });
    });

    it('should ignore non-PROMPT_ env vars', () => {
      const result = loadPromptOverrides({
        AI_DEFAULT_MODEL: 'gpt-4o',
        DATABASE_URL: 'postgres://localhost',
        PROMPT_WRITER_MODEL: 'gpt-4o',
      });
      expect(result).toEqual({
        writer: { model: 'gpt-4o' },
      });
    });

    it('should lowercase the prompt name key', () => {
      const result = loadPromptOverrides({
        PROMPT_WRITER_MODEL: 'gpt-4o',
      });
      expect(Object.keys(result!)).toEqual(['writer']);
    });
  });

  describe('loadConfig with multi-provider and prompt overrides', () => {
    it('should include defaultModel from AI_DEFAULT_MODEL', () => {
      const config = loadConfig({
        environment: 'development',
        env: {
          AI_DEFAULT_PROVIDER: 'openai',
          AI_DEFAULT_MODEL: 'gpt-4o-mini',
          AI_OPENAI_API_KEY: 'sk-test',
        },
      });
      expect(config.aiProviders?.defaultModel).toBe('gpt-4o-mini');
    });

    it('should include prompt overrides from PROMPT_ env vars', () => {
      const config = loadConfig({
        environment: 'development',
        env: {
          AI_DEFAULT_PROVIDER: 'openai',
          AI_OPENAI_API_KEY: 'sk-test',
          PROMPT_WRITER_MODEL: 'claude-sonnet-4-20250514',
          PROMPT_WRITER_PROVIDER: 'anthropic',
        },
      });
      expect(config.aiProviders?.promptOverrides).toEqual({
        writer: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
      });
    });

    it('should include both defaultModel and promptOverrides together', () => {
      const config = loadConfig({
        environment: 'development',
        env: {
          AI_DEFAULT_PROVIDER: 'openai',
          AI_DEFAULT_MODEL: 'gpt-4o',
          AI_OPENAI_API_KEY: 'sk-test',
          AI_ANTHROPIC_API_KEY: 'sk-ant-test',
          PROMPT_ANALYZER_PROVIDER: 'anthropic',
          PROMPT_ANALYZER_MODEL: 'claude-sonnet-4-20250514',
        },
      });
      expect(config.aiProviders?.defaultModel).toBe('gpt-4o');
      expect(config.aiProviders?.promptOverrides).toEqual({
        analyzer: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      });
    });
  });
});
