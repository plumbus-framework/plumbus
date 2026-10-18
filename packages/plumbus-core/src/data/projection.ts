import { z } from 'zod';
import { DataValidationError } from '../errors/index.js';

const projectionSchema = z.array(z.string().min(1)).min(1);

/** Validate projection shape and, when a schema exists, real column names. */
export function resolveSelectedFields(
  select: unknown,
  availableFields?: ReadonlySet<string>,
): string[] | undefined {
  if (select === undefined) return undefined;
  const result = projectionSchema.safeParse(select);
  if (!result.success) {
    throw new DataValidationError('findMany select must be a nonempty array of field names');
  }
  const fields = [...new Set(result.data)];
  if (availableFields && fields.some((name) => !availableFields.has(name))) {
    throw new DataValidationError('findMany select contains an unknown entity field');
  }
  return fields;
}
