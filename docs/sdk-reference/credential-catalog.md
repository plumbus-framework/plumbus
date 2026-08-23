# Credential catalog

A **credential catalog** is the host-declared list of named credential *types* and the opaque bindings that refer to them. The framework does not ship built-in types, does not mint cloud IAM, and does not store secret values. The host declares the types, stores references, and supplies field values at reveal time.

Related: [Tenant data planes](./tenant-data-planes.md) · [Security model](../security/security-model.md#credential-catalog)

## What the catalog holds

```
host declares types          catalog stores                  host resolver
(smtp, object-storage, …) →  type shapes + name/ref binds →  field values at reveal
```

| Piece | Who owns it | What is stored |
|-------|-------------|----------------|
| Type (`smtp`, …) | Host | Field names and which of them are secret |
| Binding | Catalog | Name, type id, opaque `ref`, public labels |
| Secret values | Host resolver | Never written into the catalog |

A binding's `ref` is what a database row or config record should keep. It is not a password.

## Declare types and bind

Import from `@plumbus/core` or `@plumbus/core/credentials`. The catalog is also on the package root so existing hosts keep working.

```typescript
import { createMemoryCredentialCatalog, createPlumbusRuntime } from "@plumbus/core";

const credentials = createMemoryCredentialCatalog({
  types: [
    {
      id: "smtp",
      fields: [
        { name: "host", secret: false },
        { name: "username", secret: false },
        { name: "password", secret: true },
      ],
    },
  ],
  resolve: async (record) => {
    // Host lookup by record.ref — Vault, env, Secrets Manager, …
    return lookupFields(record.ref);
  },
});

credentials.bind({
  name: "outbound-mail",
  typeId: "smtp",
  ref: "secret:smtp/outbound-mail#r1",
  labels: { host: "mail.example.test" },
});

const runtime = createPlumbusRuntime({ credentials });
```

HTTP boot (`plumbus dev` / `plumbus start`) does not use `createPlumbusRuntime`.
Export the catalog from `app/server.ts`. `loadServerExtensions` passes it to
`createServer({ credentials })`. The returned `PlumbusServer` keeps the same
object on `server.credentials`. Omitted: existing hosts boot unchanged. Do not
log the catalog as if it held secret values; it does not.

```typescript
// app/server.ts
export const credentials = catalog;
```

There is no default type list. An empty `types` array is a valid empty catalog.

## Reveal without logging secrets

`list()` / `get()` / `getByRef()` return name, type, ref, and labels only.

`reveal(name)` asks the host resolver for field values, then splits them:

- **`material.fields`** — non-secret values. Safe to log or spread.
- **`material.secret("password")`** — the only way to read a secret field.

`JSON.stringify(material)`, `util.inspect(material)`, and `String(material)` never include secret values. If the host resolver throws, the catalog raises `CredentialCatalogError` with name, type, and ref only — the resolver's own text is discarded because it may have echoed a secret.

```typescript
const mail = await credentials.reveal("outbound-mail");
await send({
  host: mail.fields.host,
  user: mail.fields.username,
  pass: mail.secret("password"),
});
```

Labels that use a secret field's name are refused at `bind`, so a password cannot be parked on the public record.

## What this is not

- Not a vault. Point `resolve` at the facility you already run.
- Not AWS IAM, STS, or per-bucket key minting.
- Not application vocabulary. Types are identifiers the host chooses (`smtp`, `object-storage`), not product domain names.
