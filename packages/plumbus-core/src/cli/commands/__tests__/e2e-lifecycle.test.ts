import { spawn } from 'node:child_process';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { assertPortFree, mergeNodeOptions, spawnOrphanWatchdog } from '../e2e.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!pidAlive(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !pidAlive(pid);
}

describe('plumbus e2e lifecycle helpers', () => {
  describe('mergeNodeOptions', () => {
    it('adds the heap cap when NODE_OPTIONS is unset', () => {
      expect(mergeNodeOptions(undefined, 4096)).toBe('--max-old-space-size=4096');
    });

    it('appends the heap cap to existing options', () => {
      expect(mergeNodeOptions('--enable-source-maps', 4096)).toBe(
        '--enable-source-maps --max-old-space-size=4096',
      );
    });

    it('respects a caller-provided heap cap', () => {
      expect(mergeNodeOptions('--max-old-space-size=8192', 4096)).toBe('--max-old-space-size=8192');
    });
  });

  describe('assertPortFree', () => {
    it('resolves for a free port and rejects with guidance for a busy one', async () => {
      const blocker = net.createServer();
      const port: number = await new Promise((resolvePort) => {
        blocker.listen(0, '127.0.0.1', () => {
          const address = blocker.address();
          resolvePort(typeof address === 'object' && address ? address.port : 0);
        });
      });

      try {
        await expect(assertPortFree(port)).rejects.toThrow(/already in use.*orphaned/s);
      } finally {
        await new Promise((resolveClose) => blocker.close(() => resolveClose(undefined)));
      }

      await expect(assertPortFree(port)).resolves.toBeUndefined();
    });
  });

  describe('spawnOrphanWatchdog', () => {
    it('reaps the server group when the CLI process disappears, escalating to SIGKILL', async () => {
      // Detached long-runner standing in for the `next dev` group leader.
      // It ignores SIGTERM so the test proves the watchdog's escalation path.
      const fakeServer = spawn(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
        {
          detached: true,
          stdio: 'ignore',
        },
      );
      // Short-lived process standing in for a SIGKILLed CLI.
      const fakeCli = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200);'], {
        stdio: 'ignore',
      });

      const serverPid = fakeServer.pid;
      const cliPid = fakeCli.pid;
      expect(serverPid).toBeTypeOf('number');
      expect(cliPid).toBeTypeOf('number');
      if (!serverPid || !cliPid) {
        return;
      }

      try {
        spawnOrphanWatchdog(cliPid, serverPid);
        // ~1s to notice the dead CLI + 5s SIGTERM grace + 1s tick to SIGKILL.
        expect(await waitUntilDead(serverPid, 10_000)).toBe(true);
      } finally {
        try {
          process.kill(-serverPid, 'SIGKILL');
        } catch {
          // Reaped by the watchdog — the expected outcome.
        }
      }
    }, 15_000);

    it('exits by itself once the server group is gone', async () => {
      const fakeServer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100);'], {
        detached: true,
        stdio: 'ignore',
      });
      const serverPid = fakeServer.pid;
      expect(serverPid).toBeTypeOf('number');
      if (!serverPid) {
        return;
      }

      const watchdogPid = spawnOrphanWatchdog(process.pid, serverPid);
      expect(watchdogPid).toBeTypeOf('number');
      if (!watchdogPid) {
        return;
      }

      expect(await waitUntilDead(watchdogPid, 5000)).toBe(true);
    }, 10_000);
  });
});
