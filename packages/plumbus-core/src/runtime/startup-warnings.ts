import type { EntityRegistry } from '../data/registry.js';
import { getEncryptedFields } from '../data/field-encryption.js';
import type { LoggerService } from '../types/context.js';
import type { PlumbusConfig } from '../types/config.js';

let warnedEncryptedWithoutKey = false;
let warnedAiSecurityBlock = false;

/** One-time warn when encrypted entity fields exist but no encryption key is configured. */
export function warnEncryptedFieldsWithoutKey(
  entities: EntityRegistry,
  encryptionKey: Buffer | undefined,
  logger: LoggerService,
): void {
  if (encryptionKey || warnedEncryptedWithoutKey) return;
  const hasEncrypted = entities
    .getAllEntities()
    .some((entity) => getEncryptedFields(entity).length > 0);
  if (!hasEncrypted) return;
  warnedEncryptedWithoutKey = true;
  logger.warn(
    'Entity fields are marked encrypted: true but PLUMBUS_ENCRYPTION_KEY is unset — values will be stored in plaintext',
  );
}

/** One-time warn when AI security block mode is enabled at bootstrap. */
export function warnAiSecurityBlockMode(config: PlumbusConfig, logger: LoggerService): void {
  if (warnedAiSecurityBlock) return;
  const mode = config.aiProviders?.security?.mode;
  if (mode !== 'block') return;
  warnedAiSecurityBlock = true;
  logger.warn(
    'AI security mode is "block" — classified entity fields in AI prompts will throw instead of redacting',
  );
}
