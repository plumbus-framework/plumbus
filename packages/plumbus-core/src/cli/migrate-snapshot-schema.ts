import { z } from 'zod';

/** Minimal Drizzle meta snapshot shape for migration generate (M2). */
export const DrizzleSnapshotSchema = z
  .object({
    id: z.string(),
    prevId: z.string().nullable().optional(),
  })
  .passthrough();

export type DrizzleSnapshot = z.infer<typeof DrizzleSnapshotSchema>;

export function parseDrizzleSnapshot(raw: string, fileLabel: string): DrizzleSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in migration snapshot ${fileLabel}`);
  }
  const result = DrizzleSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid migration snapshot ${fileLabel}: ${result.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return result.data;
}
