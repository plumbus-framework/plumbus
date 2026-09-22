export function parseDurationToMs(duration: string, opts?: { label?: string }): number {
  const trimmed = duration.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) {
    throw new Error(
      `Invalid ${opts?.label ? `${opts.label} ` : ''}duration "${duration}". Expected formats like "30s", "5m", "1h".`,
    );
  }

  const [, valueRaw, unit] = match;
  if (!valueRaw || !unit) {
    throw new Error(
      `Invalid ${opts?.label ? `${opts.label} ` : ''}duration "${duration}". Expected formats like "30s", "5m", "1h".`,
    );
  }
  const value = parseInt(valueRaw, 10);

  if (unit === 'ms') return value;
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60_000;
  if (unit === 'h') return value * 3_600_000;
  return value * 86_400_000;
}
