// Resolves smoke-app configuration from the environment. The OpenAI-compatible
// connection values (base URL, API key, model) are REQUIRED and have NO code
// defaults — you must set them in .env (copy .env.example) or export them. This
// keeps a private-network endpoint/key from ever being baked into the source.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load a local .env from the app root if present (Node built-in — no dependency).
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/** Required env var — throws a clear, actionable error when unset/empty. */
function required(name) {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(
      `Missing required env var ${name}.\n` +
        'Copy .env.example to .env and fill it in (or export the vars in your shell).\n' +
        'Required: PLUMBUS_OPENAI_BASE_URL, PLUMBUS_OPENAI_API_KEY, PLUMBUS_OPENAI_MODEL',
    );
  }
  return v.trim();
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

/** Build the resolved smoke config from the environment. */
export function loadConfig() {
  return {
    // OpenAI-compatible endpoint. The adapter POSTs to `${baseUrl}/chat/completions`,
    // so include the /v1 (or /ollama/v1) suffix. No default — must be set.
    baseUrl: required('PLUMBUS_OPENAI_BASE_URL').replace(/\/$/, ''),
    // API key sent as `Authorization: Bearer <key>`. No default — must be set.
    apiKey: required('PLUMBUS_OPENAI_API_KEY'),
    // Model name as your server exposes it. Must support native tool calling for
    // the tool phase to fire (e.g. qwen2.5, llama3.1). No default — must be set.
    model: required('PLUMBUS_OPENAI_MODEL'),
    // The user turn to send. Message content is not a secret, so it may default.
    message: optional('PLUMBUS_CHAT_MESSAGE', 'What is the weather in Helsinki right now?'),
  };
}

/** Redact a secret for display. */
export function mask(secret) {
  if (!secret) return '(none)';
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
