#!/usr/bin/env node
// Chat tool-calling smoke test.
//
//   1. copy .env.example -> .env and fill in your OpenAI-compatible server
//   2. build the framework once:  pnpm --filter @plumbus/core --filter @plumbus/chat build
//   3. run:                       node examples/chat-tool-calling-smoke/smoke.mjs
//                                 (or: PLUMBUS_CHAT_MESSAGE="weather in London?" node smoke.mjs)
//
// Exits 0 when the turn completes; prints whether the model actually invoked the
// getWeather tool (the point of the exercise) and the final answer.
import { buildApp, runTurn } from './lib/app.mjs';
import { loadConfig, mask } from './lib/config.mjs';

function line() {
  console.log('─'.repeat(72));
}

async function main() {
  const config = loadConfig();
  // A CLI arg overrides the message (env/default otherwise).
  const message = process.argv[2] ?? config.message;

  line();
  console.log('Plumbus chat tool-calling smoke test');
  line();
  console.log(`  base URL : ${config.baseUrl}`);
  console.log(`  api key  : ${mask(config.apiKey)}`);
  console.log(`  model    : ${config.model}`);
  console.log(`  message  : ${message}`);
  line();

  const app = buildApp(config);

  let toolStarted = null;
  let toolCompleted = false;
  let answer = '';
  let failed = null;
  let completed = false;

  for await (const evt of runTurn(app, message)) {
    switch (evt.type) {
      case 'turn.started':
        console.log('· turn.started');
        break;
      case 'notice':
        console.log(`· notice        ${evt.code}${evt.message ? ` — ${evt.message}` : ''}`);
        break;
      case 'tool.started':
        toolStarted = evt.name;
        console.log(`· tool.started  ${evt.name} (${evt.kind})`);
        break;
      case 'tool.completed':
        toolCompleted = true;
        console.log(`· tool.completed ${evt.name}`);
        break;
      case 'tool.failed':
        console.log(`· tool.failed   ${evt.name} — ${evt.code}: ${evt.message}`);
        break;
      case 'message.delta':
        answer += evt.text ?? '';
        break;
      case 'turn.completed':
        completed = true;
        console.log('· turn.completed');
        break;
      case 'turn.failed':
        failed = evt;
        console.log(`· turn.failed   ${evt.code} — ${evt.message}`);
        break;
      default:
        console.log(`· ${evt.type}`);
    }
  }

  line();
  if (answer) console.log(`Answer: ${answer.trim()}`);
  line();
  console.log(`tool invoked : ${toolCompleted ? `yes (${toolStarted})` : 'no'}`);
  console.log(`turn status  : ${failed ? `failed (${failed.code})` : completed ? 'completed' : 'incomplete'}`);
  line();

  if (failed) process.exit(1);
  if (!toolCompleted) {
    console.log(
      'Note: the turn completed but the model did not call getWeather. Use a model that\n' +
        'supports native tool calling (e.g. qwen2.5, llama3.1) via PLUMBUS_OPENAI_MODEL.',
    );
  }
  process.exit(completed ? 0 : 1);
}

main().catch((err) => {
  line();
  console.error('Smoke test failed:\n');
  console.error(err?.stack ?? String(err));
  if (String(err?.message ?? err).match(/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|timed out/i)) {
    console.error(
      '\nCould not reach the OpenAI-compatible server. Check PLUMBUS_OPENAI_BASE_URL is\n' +
        'reachable from this host and the server is running.',
    );
  }
  process.exit(1);
});
