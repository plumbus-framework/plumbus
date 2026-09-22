# Client Generator

The client generator produces typed fetch-based API clients, React hooks, and flow trigger functions from Plumbus capability contracts and flow trigger descriptors.

## Configuration

```ts
interface ClientGeneratorConfig {
  baseUrl?: string;
  includeJsDoc?: boolean;
  toastImport?: string;
}
```

- `baseUrl` defaults to an empty string.
- `includeJsDoc` adds generated JSDoc comments.
- `toastImport` defaults to `"sonner"` and is used by generated hooks.

## Naming helpers

Use these helpers when another generator or package must refer to generated names:

```ts
capabilityClientFnName(capability);
flowTriggerFnName(flow);
```

## Individual generators

### `generateCapabilityTypes(cap)`

Generates TypeScript aliases for a capability input and output:

```ts
generateCapabilityTypes(getUserCapability);
// export type GetUserInput = ...;
// export type GetUserOutput = ...;
```

The implementation derives type strings from Zod schemas where possible. Complex or unsupported schema shapes may fall back to broader TypeScript types.

### `generateTypedClient(cap, config?)`

Generates one async fetch function for a capability.

```ts
generateTypedClient(getUserCapability, { baseUrl: "" });
// export async function getUser(input: GetUserInput, options?: ...): Promise<GetUserOutput> { ... }
```

Generated behavior:

- query capabilities use `GET`;
- action and job capabilities use `POST`;
- route paths are derived from `/api/{domain}/{kebab-capability-name}`;
- query input is serialized with `URLSearchParams`;
- post input is serialized with `JSON.stringify(input)`;
- each function accepts optional `headers` and `signal`;
- non-OK responses throw an error enriched with response details when possible.

### `generateQueryHook(cap, config?)`

Generates a React hook for a query capability.

```ts
generateQueryHook(getUserCapability);
// export function useGetUser(input: GetUserInput, options?: { onError?: (err: Error) => void }) { ... }
```

Generated query hooks:

- use `useState` and `useEffect`;
- fetch on mount and when `JSON.stringify(input)` changes;
- track `data`, `loading`, and `error`;
- use a local `cancelled` flag in effect cleanup;
- call `options.onError(error)` when provided;
- otherwise call `toast.error(error.message)`.

They are not TanStack Query hooks.

### `generateMutationHook(cap, config?)`

Generates a React hook for action/job capabilities.

```ts
generateMutationHook(createUserCapability);
// export function useCreateUser(options?: { onError?: (err: Error) => void }) { ... }
```

Generated mutation hooks:

- expose `mutate(input)`;
- track `data`, `loading`, and `error`;
- expose `reset()`;
- call `options.onError(error)` when provided;
- otherwise call `toast.error(error.message)`.

### `generateReactHook(cap, config?)`

Delegates to `generateQueryHook` for query capabilities and `generateMutationHook` for other capability kinds.

### `generateFlowTrigger(flow, config?)`

Generates a function named `start{PascalFlowName}`.

```ts
generateFlowTrigger({ name: "orderFulfillment", domain: "orders" });
// export async function startOrderFulfillment(input: Record<string, unknown>, options?: ...)
```

Generated flow triggers post to `/api/{domain}/{kebab-flow-name}/start` and return:

```ts
Promise<{ executionId: string; status: string }>
```

Flow generation in this package covers starting flows only. It does not generate status polling, step timelines, approval controls, retry controls, or wait/resume UI.

### `generateErrorTypes()`

Generates shared error helper types:

```ts
interface PlumbusApiError {
  status: number;
  code?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

function isPlumbusApiError(error: unknown): error is PlumbusApiError;
```

## Module generators

### `generateClientModule(capabilities, flows, config?)`

Generates a complete client module:

```ts
const source = generateClientModule(capabilities, flows, {
  baseUrl: "",
  includeJsDoc: true,
});
```

The generated file includes:

- the auto-generated file header;
- shared error types;
- generated capability types;
- generated capability client functions;
- generated flow trigger functions.

### `generateHooksModule(capabilities, config?)`

Generates a complete hooks module:

```ts
const source = generateHooksModule(capabilities, {
  toastImport: "sonner",
});
```

The generated file imports React hooks and the configured toast library, imports generated client functions/types, and emits one hook per capability.

## Runtime expectations

Generated clients use `fetch` and should run in browser environments or frontend/server environments where `fetch` is available.

Generated hooks require React. They should be written into client-side source files in frameworks such as Next.js.

Generated client and hook modules do not import `@plumbus/ui` at runtime. Translation files are the package-level exception and may import `@plumbus/ui/next-intl` subpaths.
