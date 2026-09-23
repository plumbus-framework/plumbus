import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createErrorService, z } from './deps.mjs';
import { ensureEnvironment, loadConfig, repoRoot } from './config.mjs';
import { runSmoke } from './app.mjs';

const container = 'plumbus-ai-decision-smoke';
const image = 'plumbus-laya-smoke:local';
const volume = 'plumbus-ai-decision-smoke-cache';

function docker(args, { inherit = false, allowMissing = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd: repoRoot,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', () =>
      reject(
        createErrorService().internal('Could not run Docker. Install Docker and start its daemon.'),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else if (allowMissing && /no such (object|container)/i.test(stderr)) resolve(null);
      else
        reject(
          createErrorService().internal(
            `Docker ${args[0]} failed. ${stderr.trim() || 'See the command output above.'}`,
          ),
        );
    });
  });
}

async function ownedContainer() {
  const json = await docker(['inspect', '--format', '{{json .Config.Labels}}', container], {
    allowMissing: true,
  });
  if (json === null) return false;
  const labels = z.record(z.string()).parse(JSON.parse(json));
  if (
    labels['com.plumbus.example'] !== 'ai-decision-smoke' ||
    labels['com.plumbus.workspace'] !== repoRoot.replace(/\/$/, '')
  ) {
    throw createErrorService().conflict(
      `Container ${container} belongs to another setup; it will not be changed.`,
    );
  }
  return true;
}

async function waitForReady(config) {
  const started = Date.now();
  let lastNotice = 0;
  while (Date.now() - started < 15 * 60_000) {
    try {
      const response = await fetch(`${config.origin}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      const ready = z
        .object({ ready: z.literal(true), models: z.array(z.string()) })
        .safeParse(await response.json());
      if (response.ok && ready.success && ready.data.models.includes(config.model)) return;
    } catch {
      /* First boot downloads and loads weights before opening the socket. */
    }
    const state = await docker(['inspect', '--format', '{{.State.Running}}', container]);
    if (state !== 'true')
      throw createErrorService().internal(
        'Laya stopped during startup. Run: node examples/ai-decision-smoke/run.mjs logs',
      );
    if (Date.now() - lastNotice > 15_000) {
      console.log(
        `Waiting for ${config.model} to download/load (${Math.round((Date.now() - started) / 1000)}s)…`,
      );
      lastNotice = Date.now();
    }
    await delay(1000);
  }
  throw createErrorService().internal(
    'Laya has not become ready in 15 minutes. Inspect the logs; downloaded files remain in the cache.',
  );
}

export async function runCommand(command, message) {
  if (
    !z.enum(['run', 'start', 'restart', 'smoke', 'status', 'logs', 'stop']).safeParse(command)
      .success
  ) {
    throw createErrorService().validation(
      'Usage: node examples/ai-decision-smoke/run.mjs [start|restart|smoke|status|logs|stop] [message]',
    );
  }
  if (['logs', 'stop', 'status'].includes(command)) {
    if (!(await ownedContainer())) {
      console.log(
        'The example server has not been created yet. Run this script without arguments.',
      );
      return;
    }
    if (command === 'logs') await docker(['logs', '--tail', '60', container], { inherit: true });
    else if (command === 'stop') {
      await docker(['stop', container]);
      console.log('Stopped Laya. Password and model cache retained.');
    } else {
      console.log(
        `Container running: ${await docker(['inspect', '--format', '{{.State.Running}}', container])}`,
      );
      const config = await loadConfig();
      const ready = await fetch(`${config.origin}/healthz`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.json())
        .catch(() => ({ ready: false }));
      console.log(JSON.stringify(ready));
    }
    return;
  }

  const config = command === 'smoke' ? await loadConfig() : await ensureEnvironment();
  if (command !== 'smoke') {
    const exists = await ownedContainer();
    if (exists && command === 'restart') {
      await docker(['stop', container]);
      await docker(['rm', container]);
    }
    if (!exists || command === 'restart') {
      console.log('Building the CPU server image (cached on later runs)…');
      await docker(['build', '-t', image, 'packages/ai-decision-laya/service'], { inherit: true });
      await docker([
        'run',
        '-d',
        '--name',
        container,
        '--label',
        'com.plumbus.example=ai-decision-smoke',
        '--label',
        `com.plumbus.workspace=${repoRoot.replace(/\/$/, '')}`,
        '--env-file',
        config.envFile,
        '--cpus=2',
        '--memory=6g',
        '--memory-swap=6g',
        '-p',
        `127.0.0.1:${config.port}:8080`,
        '-v',
        `${volume}:/home/laya/.cache/huggingface`,
        image,
      ]);
    } else {
      await docker(['start', container]);
    }
    await waitForReady(config);
    console.log(`Laya ready: ${config.baseUrl} (${config.model}, CPU)`);
    console.log(`Password is managed in ${config.envFile}; no manual password setup is needed.`);
  }

  if (command === 'run' || command === 'smoke') {
    const result = await runSmoke(config, { message });
    console.table(
      result.results.map((row) => ({
        adapter: row.provider,
        checkpoint: row.routing.model,
        department: row.answers.department.choice,
        refundProbability: row.answers.refund.probability,
        tokens: row.usage.totalTokens,
        latencyMs: Math.round(row.latencyMs),
        cost: row.cost === null ? 'unknown (local model)' : row.cost,
      })),
    );
    console.log(`PASS: ${result.checks.join('; ')}.`);
    console.log(
      'The server remains running. Stop it with: node examples/ai-decision-smoke/run.mjs stop',
    );
  }
}
