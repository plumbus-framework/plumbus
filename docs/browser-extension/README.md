# Browser extension (`@plumbus/browser-extension`)

Dev-time scaffolder that emits a [WXT](https://wxt.dev/) Chrome/Firefox extension wired to your Plumbus app's capabilities.

## Docs

| Doc | Read when… |
|-----|------------|
| [usage.md](./usage.md) | You want to scaffold, build, and ship an extension against a Plumbus backend. |
| [../cli/commands.md](../cli/commands.md#plumbus-browser-extension-scaffold) | You need the full CLI option table. |
| [`packages/browser-extension/README.md`](../../packages/browser-extension/README.md) | You want the package overview and public API table. |
| [`packages/browser-extension/instructions/browser-extension.md`](../../packages/browser-extension/instructions/browser-extension.md) | You're an agent wiring auth, CORS, and access policies (ships in the npm tarball). |

## Install

```bash
pnpm add @plumbus/ui @plumbus/browser-extension
```

Both are dev-time add-ons. The generated extension does **not** depend on `@plumbus/browser-extension` at runtime.

## Quick start

```bash
plumbus browser-extension scaffold ./extension \
  --app-name my-app \
  --api-base-url https://api.example.com
```

See [usage.md](./usage.md) for prerequisites (app-owned auth + CORS), build commands, and regeneration workflow.
