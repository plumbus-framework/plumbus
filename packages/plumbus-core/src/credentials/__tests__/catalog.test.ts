import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../types/enums.js';
import {
  CREDENTIAL_REDACTED,
  CredentialCatalogError,
  createMemoryCredentialCatalog,
  type CredentialTypeDeclaration,
} from '../catalog.js';

const SMTP: CredentialTypeDeclaration = {
  id: 'smtp',
  fields: [
    { name: 'host', secret: false },
    { name: 'username', secret: false },
    { name: 'password', secret: true },
  ],
};

const PASSWORD = 's3cret-mail-pass';

function catalogWithSmtp() {
  return createMemoryCredentialCatalog({
    types: [SMTP],
    resolve: async (record) => {
      if (record.name !== 'outbound-mail') {
        throw new Error('unknown binding');
      }
      return {
        host: 'mail.example.test',
        username: 'notifier',
        password: PASSWORD,
      };
    },
  });
}

describe('createMemoryCredentialCatalog', () => {
  it('holds only the types the host declared', () => {
    const catalog = createMemoryCredentialCatalog({ types: [SMTP] });
    expect(catalog.listTypes().map((type) => type.id)).toEqual(['smtp']);
    expect(catalog.getType('smtp')?.fields).toEqual(SMTP.fields);
    expect(catalog.getType('object-storage')).toBeUndefined();
  });

  it('ships no built-in types', () => {
    const catalog = createMemoryCredentialCatalog({ types: [] });
    expect(catalog.listTypes()).toEqual([]);
  });

  it('binds an opaque ref and never stores field values', () => {
    const catalog = catalogWithSmtp();
    const bound = catalog.bind({
      name: 'outbound-mail',
      typeId: 'smtp',
      ref: 'secret:smtp/outbound-mail#r1',
      labels: { host: 'mail.example.test' },
    });

    expect(bound).toEqual({
      name: 'outbound-mail',
      typeId: 'smtp',
      ref: 'secret:smtp/outbound-mail#r1',
      labels: { host: 'mail.example.test' },
    });
    expect(JSON.stringify(catalog.list())).not.toContain(PASSWORD);
    expect(catalog.get('outbound-mail')?.ref).toBe('secret:smtp/outbound-mail#r1');
    expect(catalog.getByRef('secret:smtp/outbound-mail#r1')?.name).toBe('outbound-mail');
  });

  it('refuses a binding of an undeclared type', () => {
    const catalog = createMemoryCredentialCatalog({ types: [SMTP] });
    expect(() =>
      catalog.bind({
        name: 'bucket',
        typeId: 'object-storage',
        ref: 'secret:object-storage/bucket#r1',
      }),
    ).toThrow(CredentialCatalogError);
  });

  it('refuses a label that names a secret field', () => {
    const catalog = catalogWithSmtp();
    expect(() =>
      catalog.bind({
        name: 'outbound-mail',
        typeId: 'smtp',
        ref: 'secret:smtp/outbound-mail#r1',
        labels: { password: PASSWORD },
      }),
    ).toThrow(/secret field/);
  });

  it('reveals public fields and keeps secrets off the logged surface', async () => {
    const catalog = catalogWithSmtp();
    catalog.bind({
      name: 'outbound-mail',
      typeId: 'smtp',
      ref: 'secret:smtp/outbound-mail#r1',
    });

    const material = await catalog.reveal('outbound-mail');
    expect(material.fields).toEqual({
      host: 'mail.example.test',
      username: 'notifier',
    });
    expect(material.secret('password')).toBe(PASSWORD);
    expect(material.fields).not.toHaveProperty('password');
    expect(Object.keys(material)).toEqual(['typeId', 'name', 'ref', 'fields']);

    const serialized = JSON.stringify(material);
    const inspected = inspect(material);
    const spread = { ...material.fields };
    expect(serialized).not.toContain(PASSWORD);
    expect(inspected).not.toContain(PASSWORD);
    expect(String(material)).not.toContain(PASSWORD);
    expect(spread).not.toHaveProperty('password');
    expect(serialized).toContain('mail.example.test');
    expect(inspected).not.toContain(CREDENTIAL_REDACTED);
  });

  it('does not attach a host resolver error that echoed a secret', async () => {
    const catalog = createMemoryCredentialCatalog({
      types: [SMTP],
      resolve: async () => {
        throw new Error(`login failed for ${PASSWORD}`);
      },
    });
    catalog.bind({
      name: 'outbound-mail',
      typeId: 'smtp',
      ref: 'secret:smtp/outbound-mail#r1',
    });

    const error = await catalog.reveal('outbound-mail').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CredentialCatalogError);
    expect((error as CredentialCatalogError).code).toBe(ErrorCode.Internal);
    expect((error as CredentialCatalogError).message).not.toContain(PASSWORD);
    expect((error as CredentialCatalogError).message).toContain('Could not resolve credential');
    expect(JSON.stringify(error)).not.toContain(PASSWORD);
    expect((error as CredentialCatalogError).cause).toBeUndefined();
  });

  it('refuses reveal when the host did not supply a resolver', async () => {
    const catalog = createMemoryCredentialCatalog({ types: [SMTP] });
    catalog.bind({
      name: 'outbound-mail',
      typeId: 'smtp',
      ref: 'secret:smtp/outbound-mail#r1',
    });
    await expect(catalog.reveal('outbound-mail')).rejects.toBeInstanceOf(CredentialCatalogError);
  });

  it('refuses duplicate type ids, names, and refs', () => {
    expect(() => createMemoryCredentialCatalog({ types: [SMTP, SMTP] })).toThrow(
      /already declared/,
    );

    const catalog = catalogWithSmtp();
    catalog.bind({
      name: 'outbound-mail',
      typeId: 'smtp',
      ref: 'secret:smtp/outbound-mail#r1',
    });
    expect(() =>
      catalog.bind({
        name: 'outbound-mail',
        typeId: 'smtp',
        ref: 'secret:smtp/outbound-mail#r2',
      }),
    ).toThrow(/already bound/);
    expect(() =>
      catalog.bind({
        name: 'other-mail',
        typeId: 'smtp',
        ref: 'secret:smtp/outbound-mail#r1',
      }),
    ).toThrow(/already in use/);
  });
});
