export interface VoiceSessionLifecycleConfig {
  maxSessionDurationSeconds?: number;
  idleTimeoutSeconds?: number;
  onIdleTimeout?: () => void | Promise<void>;
  onMaxDuration?: () => void | Promise<void>;
}

export interface VoiceSessionLifecycle {
  bumpActivity(): void;
  start(): void;
  stop(): void;
}

export function createVoiceSessionLifecycle(
  config: VoiceSessionLifecycleConfig = {},
): VoiceSessionLifecycle {
  let startedAt = Date.now();
  let lastActivity = startedAt;
  let timer: ReturnType<typeof setInterval> | undefined;
  let idleTriggered = false;
  let durationTriggered = false;

  return {
    bumpActivity() {
      lastActivity = Date.now();
    },
    start() {
      if (timer) return;
      startedAt = Date.now();
      lastActivity = startedAt;
      timer = setInterval(() => {
        const now = Date.now();
        if (
          !idleTriggered &&
          config.idleTimeoutSeconds !== undefined &&
          config.idleTimeoutSeconds > 0 &&
          now - lastActivity >= config.idleTimeoutSeconds * 1000
        ) {
          idleTriggered = true;
          void config.onIdleTimeout?.();
        }
        if (
          !durationTriggered &&
          config.maxSessionDurationSeconds !== undefined &&
          config.maxSessionDurationSeconds > 0 &&
          now - startedAt >= config.maxSessionDurationSeconds * 1000
        ) {
          durationTriggered = true;
          void config.onMaxDuration?.();
        }
      }, 250);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
