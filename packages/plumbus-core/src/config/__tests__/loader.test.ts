import { describe, expect, it } from "vitest";
import type { PlumbusConfig } from "../../types/config.js";
import { loadConfig, validateConfig } from "../loader.js";

// ── Tests ──

describe("Config Loader", () => {
  describe("loadConfig", () => {
    it("loads config with development defaults when no env vars set", () => {
      const config = loadConfig({ env: {} });
      expect(config.environment).toBe("development");
      expect(config.database.host).toBe("localhost");
      expect(config.database.port).toBe(5432);
      expect(config.database.database).toBe("plumbus_dev");
      expect(config.database.user).toBe("postgres");
      expect(config.database.password).toBe("postgres");
      expect(config.database.poolSize).toBe(5);
    });

    it("uses PLUMBUS_ENV for environment", () => {
      const config = loadConfig({ env: { PLUMBUS_ENV: "staging" } });
      expect(config.environment).toBe("staging");
    });

    it("falls back to NODE_ENV when PLUMBUS_ENV is not set", () => {
      const config = loadConfig({ env: { NODE_ENV: "production" } });
      expect(config.environment).toBe("production");
    });

    it("prefers PLUMBUS_ENV over NODE_ENV", () => {
      const config = loadConfig({
        env: { PLUMBUS_ENV: "staging", NODE_ENV: "production" },
      });
      expect(config.environment).toBe("staging");
    });

    it("allows environment override via options", () => {
      const config = loadConfig({
        environment: "production",
        env: { PLUMBUS_ENV: "development" },
      });
      expect(config.environment).toBe("production");
    });

    it("reads database config from env vars", () => {
      const config = loadConfig({
        env: {
          DATABASE_HOST: "db.example.com",
          DATABASE_PORT: "5433",
          DATABASE_NAME: "mydb",
          DATABASE_USER: "admin",
          DATABASE_PASSWORD: "secret123",
          DATABASE_SSL: "true",
          DATABASE_POOL_SIZE: "10",
        },
      });
      expect(config.database.host).toBe("db.example.com");
      expect(config.database.port).toBe(5433);
      expect(config.database.database).toBe("mydb");
      expect(config.database.user).toBe("admin");
      expect(config.database.password).toBe("secret123");
      expect(config.database.ssl).toBe(true);
      expect(config.database.poolSize).toBe(10);
    });

    it("supports PG* env var aliases", () => {
      const config = loadConfig({
        env: {
          PGHOST: "pg.example.com",
          PGPORT: "5434",
          PGDATABASE: "pgdb",
          PGUSER: "pgadmin",
          PGPASSWORD: "pgpass",
        },
      });
      expect(config.database.host).toBe("pg.example.com");
      expect(config.database.port).toBe(5434);
      expect(config.database.database).toBe("pgdb");
      expect(config.database.user).toBe("pgadmin");
      expect(config.database.password).toBe("pgpass");
    });

    it("prefers DATABASE_* over PG* aliases", () => {
      const config = loadConfig({
        env: {
          DATABASE_HOST: "primary",
          PGHOST: "secondary",
        },
      });
      expect(config.database.host).toBe("primary");
    });

    it("enables SSL in production by default", () => {
      const config = loadConfig({
        environment: "production",
        env: {},
      });
      expect(config.database.ssl).toBe(true);
    });

    it("uses larger pool size in production", () => {
      const config = loadConfig({
        environment: "production",
        env: {},
      });
      expect(config.database.poolSize).toBe(20);
    });

    it("reads queue config from env vars", () => {
      const config = loadConfig({
        env: {
          QUEUE_HOST: "redis.example.com",
          QUEUE_PORT: "6380",
          QUEUE_PASSWORD: "redispass",
          QUEUE_PREFIX: "myapp:",
        },
      });
      expect(config.queue.host).toBe("redis.example.com");
      expect(config.queue.port).toBe(6380);
      expect(config.queue.password).toBe("redispass");
      expect(config.queue.prefix).toBe("myapp:");
    });

    it("supports REDIS_* env var aliases for queue", () => {
      const config = loadConfig({
        env: {
          REDIS_HOST: "redis2.example.com",
          REDIS_PORT: "6381",
          REDIS_PASSWORD: "redispass2",
        },
      });
      expect(config.queue.host).toBe("redis2.example.com");
      expect(config.queue.port).toBe(6381);
      expect(config.queue.password).toBe("redispass2");
    });

    it("defaults queue prefix to plumbus:{environment}", () => {
      const config = loadConfig({ env: {} });
      expect(config.queue.prefix).toBe("plumbus:development");
    });

    it("returns undefined for AI when no AI env vars set", () => {
      const config = loadConfig({ env: {} });
      expect(config.ai).toBeUndefined();
    });

    it("loads AI config when both provider and apiKey are set", () => {
      const config = loadConfig({
        env: {
          AI_PROVIDER: "openai",
          AI_API_KEY: "sk-test",
          AI_MODEL: "gpt-4",
          AI_BASE_URL: "https://api.openai.com",
          AI_MAX_TOKENS: "4096",
          AI_DAILY_COST_LIMIT: "10.5",
        },
      });
      expect(config.ai).toBeDefined();
      expect(config.ai!.provider).toBe("openai");
      expect(config.ai!.apiKey).toBe("sk-test");
      expect(config.ai!.model).toBe("gpt-4");
      expect(config.ai!.baseUrl).toBe("https://api.openai.com");
      expect(config.ai!.maxTokensPerRequest).toBe(4096);
      expect(config.ai!.dailyCostLimit).toBe(10.5);
    });

    it("returns undefined for AI when only provider set (no key)", () => {
      const config = loadConfig({ env: { AI_PROVIDER: "openai" } });
      expect(config.ai).toBeUndefined();
    });

    it("reads auth config from env vars", () => {
      const config = loadConfig({
        env: {
          AUTH_PROVIDER: "auth0",
          AUTH_ISSUER: "https://issuer.example.com",
          AUTH_AUDIENCE: "https://api.example.com",
          AUTH_JWKS_URI: "https://issuer.example.com/.well-known/jwks.json",
          AUTH_SECRET: "my-secret",
        },
      });
      expect(config.auth.provider).toBe("auth0");
      expect(config.auth.issuer).toBe("https://issuer.example.com");
      expect(config.auth.audience).toBe("https://api.example.com");
      expect(config.auth.jwksUri).toBe("https://issuer.example.com/.well-known/jwks.json");
      expect(config.auth.secret).toBe("my-secret");
    });

    it("defaults auth secret to development-secret in dev", () => {
      const config = loadConfig({ env: {} });
      expect(config.auth.secret).toBe("development-secret");
    });

    it("does not default auth secret in production", () => {
      const config = loadConfig({ environment: "production", env: {} });
      expect(config.auth.secret).toBeUndefined();
    });

    it("parses compliance profiles from comma-separated env var", () => {
      const config = loadConfig({
        env: { PLUMBUS_COMPLIANCE_PROFILES: "hipaa,gdpr,sox" },
      });
      expect(config.complianceProfiles).toEqual(["hipaa", "gdpr", "sox"]);
    });

    it("trims whitespace from compliance profiles", () => {
      const config = loadConfig({
        env: { PLUMBUS_COMPLIANCE_PROFILES: " hipaa , gdpr " },
      });
      expect(config.complianceProfiles).toEqual(["hipaa", "gdpr"]);
    });

    it("returns undefined compliance profiles when env var not set", () => {
      const config = loadConfig({ env: {} });
      expect(config.complianceProfiles).toBeUndefined();
    });
  });

  describe("validateConfig", () => {
    function makeValidConfig(overrides?: Partial<PlumbusConfig>): PlumbusConfig {
      return {
        environment: "development",
        database: {
          host: "localhost",
          port: 5432,
          database: "plumbus_dev",
          user: "postgres",
          password: "postgres",
        },
        queue: { host: "localhost", port: 6379, prefix: "plumbus:dev" },
        auth: { provider: "jwt", secret: "test-secret" },
        ...overrides,
      };
    }

    it("returns valid for a complete dev config", () => {
      const result = validateConfig(makeValidConfig());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("errors when database host is empty", () => {
      const result = validateConfig(
        makeValidConfig({ database: { host: "", port: 5432, database: "db", user: "u", password: "p" } }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("database.host is required");
    });

    it("errors when database name is empty", () => {
      const result = validateConfig(
        makeValidConfig({ database: { host: "h", port: 5432, database: "", user: "u", password: "p" } }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("database.database is required");
    });

    it("errors when database user is empty", () => {
      const result = validateConfig(
        makeValidConfig({ database: { host: "h", port: 5432, database: "db", user: "", password: "p" } }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("database.user is required");
    });

    it("errors in production when database password is empty", () => {
      const result = validateConfig(
        makeValidConfig({
          environment: "production",
          database: { host: "h", port: 5432, database: "db", user: "u", password: "", ssl: true },
          auth: { provider: "jwt", secret: "prod-secret" },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("database.password is required in production");
    });

    it("warns in production when SSL is disabled", () => {
      const result = validateConfig(
        makeValidConfig({
          environment: "production",
          database: { host: "h", port: 5432, database: "db", user: "u", password: "p", ssl: false },
          auth: { provider: "jwt", secret: "prod-secret" },
        }),
      );
      expect(result.warnings).toContain("database.ssl should be enabled in production");
    });

    it("errors in production when auth secret is development-secret", () => {
      const result = validateConfig(
        makeValidConfig({
          environment: "production",
          database: { host: "h", port: 5432, database: "db", user: "u", password: "p", ssl: true },
          auth: { provider: "jwt", secret: "development-secret" },
        }),
      );
      expect(result.errors).toContain("auth.secret must be changed from default in production");
    });

    it("errors in production when no auth secret or jwksUri", () => {
      const result = validateConfig(
        makeValidConfig({
          environment: "production",
          database: { host: "h", port: 5432, database: "db", user: "u", password: "p", ssl: true },
          auth: { provider: "jwt" },
        }),
      );
      expect(result.errors).toContain("auth.secret or auth.jwksUri is required in production");
    });

    it("valid in production with jwksUri and no secret", () => {
      const result = validateConfig(
        makeValidConfig({
          environment: "production",
          database: { host: "h", port: 5432, database: "db", user: "u", password: "p", ssl: true },
          auth: { provider: "auth0", jwksUri: "https://example.com/.well-known/jwks.json" },
        }),
      );
      expect(result.valid).toBe(true);
    });

    it("errors when AI config has no apiKey", () => {
      const result = validateConfig(
        makeValidConfig({
          ai: { provider: "openai", apiKey: "" },
        }),
      );
      expect(result.errors).toContain("ai.apiKey is required when AI is configured");
    });

    it("errors when AI config has no provider", () => {
      const result = validateConfig(
        makeValidConfig({
          ai: { provider: "", apiKey: "sk-test" },
        }),
      );
      expect(result.errors).toContain("ai.provider is required when AI is configured");
    });

    it("valid when AI is not configured (undefined)", () => {
      const result = validateConfig(makeValidConfig());
      expect(result.valid).toBe(true);
    });

    it("returns multiple errors when config has multiple issues", () => {
      const result = validateConfig(
        makeValidConfig({
          environment: "production",
          database: { host: "", port: 5432, database: "", user: "", password: "", ssl: false },
          auth: { provider: "jwt", secret: "development-secret" },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });
});
