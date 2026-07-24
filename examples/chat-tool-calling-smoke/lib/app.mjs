// Builds the in-memory chat runtime that exercises @plumbus/chat provider-native
// tool calling (Path B) against an OpenAI-compatible server.
//
// Flow of a turn: scope preflight (chat.scopeCheck) -> tool phase (chat.toolRound;
// the model may call allowlisted tools; the runtime runs them via executeCapability)
// -> answer phase (chat.turn). We allowlist a single READ-ONLY capability (getWeather,
// empty effects => "auto" mode), so nothing needs confirmation and no database/store
// is involved — the whole turn runs in-memory.
import { randomUUID } from 'node:crypto';
import {
  PromptRegistry,
  createAIService,
  createChatRegistry,
  createExecutionContext,
  createOpenAIAdapter,
  chatScopeCheckPrompt,
  chatToolRoundPrompt,
  chatTurnPrompt,
  defineCapability,
  defineChat,
  runChatTurn,
  singleProviderConfig,
  z,
} from './deps.mjs';
import { createInMemoryData } from './in-memory-data.mjs';

/**
 * A read-only tool the model can call. All effect arrays are empty, so the tool
 * binder classifies it `auto` — it runs inline during the turn, no confirmation.
 * Replace the canned body with a real fetch to demo live data.
 */
function defineGetWeather() {
  return defineCapability({
    name: 'getWeather',
    kind: 'query',
    domain: 'weather',
    description: 'Get the current weather for a city. Call this to answer weather questions.',
    input: z.object({ city: z.string().describe('City name, e.g. "Helsinki"') }),
    output: z.object({
      city: z.string(),
      temperatureC: z.number(),
      condition: z.string(),
    }),
    access: { roles: ['user'] },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async (_ctx, { city }) => {
      // Canned deterministic result — this is a smoke test, not a weather service.
      const table = {
        helsinki: { temperatureC: 3, condition: 'Light snow' },
        london: { temperatureC: 9, condition: 'Overcast' },
        'san francisco': { temperatureC: 16, condition: 'Foggy' },
      };
      const hit = table[city.trim().toLowerCase()] ?? { temperatureC: 12, condition: 'Clear' };
      return { city, temperatureC: hit.temperatureC, condition: hit.condition };
    },
  });
}

/**
 * Assemble the runtime: a real OpenAI-compatible AIService pointed at the configured
 * server, the three Path B prompts registered, an in-memory ExecutionContext, and a
 * tool-calling chat that allowlists getWeather.
 */
export function buildApp(config) {
  // 1. Register the three prompts Path B resolves by name. The SAME registry instance
  //    backs both the AI service (prompt text/model) and the chat registry (presence check).
  const prompts = new PromptRegistry();
  prompts.register(chatTurnPrompt); // 'chat.turn'      — final structured answer
  prompts.register(chatToolRoundPrompt); // 'chat.toolRound' — tool-selection round
  prompts.register(chatScopeCheckPrompt); // 'chat.scopeCheck'— in-scope preflight

  // 2. Real AIService pointed at the OpenAI-compatible server. `defaultModel` is
  //    authoritative (it becomes request.model on every call); the adapter `model`
  //    is a belt-and-suspenders fallback. Both come from config — no hardcoded model.
  const adapter = createOpenAIAdapter({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });
  const ai = createAIService(
    singleProviderConfig(adapter, { promptRegistry: prompts, defaultModel: config.model }),
  );

  // 3. In-memory ExecutionContext (no vitest, no Postgres): real ctx.ai +
  //    auto-vivifying in-memory data + a capability resolver the tool phase uses
  //    (it calls ctx.__runtime.resolveCapability(name) then executeCapability).
  //    We resolve by the BARE capability name used in the allowlist — the provider
  //    tool-name grammar (^[A-Za-z][A-Za-z0-9_-]{0,63}$) forbids the dotted canonical
  //    `${domain}.${name}` that the core CapabilityRegistry keys by.
  const getWeather = defineGetWeather();
  const capabilitiesByName = new Map([[getWeather.name, getWeather]]);
  const ctx = createExecutionContext({
    auth: {
      userId: 'smoke-user',
      roles: ['user'],
      scopes: [],
      tenantId: 'smoke-tenant',
      provider: 'smoke',
    },
    data: createInMemoryData(),
    ai,
    resolveCapability: (name) => capabilitiesByName.get(name),
  });

  // 4. A chat with provider-native tool calling enabled, allowlisting getWeather.
  const chat = defineChat({
    name: 'weather-bot',
    access: { roles: ['user'] },
    instructions: [
      'You are a concise weather assistant.',
      'When the user asks about weather, call the getWeather tool to get real data, then answer.',
    ],
    context: [],
    policy: {
      scope: {
        description:
          'Answering questions about the current weather in any city IS in scope. ' +
          'Anything unrelated to weather is out of scope.',
      },
      toolCalling: { enabled: true, capabilities: ['getWeather'] },
    },
  });

  // 5. Chat registry lets Path B verify chat.toolRound / chat.scopeCheck are registered.
  const chatRegistry = createChatRegistry(prompts);

  return { ctx, chat, chatRegistry };
}

/**
 * Run one chat turn and return the async event stream (turn.started, tool.started,
 * tool.completed, message.delta, turn.completed, ...).
 */
export function runTurn(app, message, { audience = 'user', locale = 'en' } = {}) {
  return runChatTurn(app.ctx, {
    chatDefinition: app.chat,
    sessionId: randomUUID(),
    userMessage: message,
    audience,
    locale,
    registry: app.chatRegistry,
  });
}
