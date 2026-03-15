# Client Generator

Generates typed fetch-based API clients and React hooks from capability contracts and flow definitions.

## Configuration

```ts
interface ClientGeneratorConfig {
  /** Base URL for API requests (default: "") */
  baseUrl?: string;
  /** Include JSDoc comments in generated code */
  includeJsDoc?: boolean;
}
```

## Individual Generators

### `generateCapabilityTypes(cap)`

Produces TypeScript type aliases for a capability's input and output:

```ts
generateCapabilityTypes({ name: "getUser", kind: "query", domain: "users", ... })
// → export type GetUserInput = Record<string, unknown>;
//   export type GetUserOutput = Record<string, unknown>;
```

### `generateTypedClient(cap, config?)`

Produces an async fetch function for a capability. Route path follows `GET /api/{domain}/{kebab-name}` for queries, `POST` for actions/jobs:

```ts
generateTypedClient({ name: "getUser", kind: "query", domain: "users", ... })
// → export async function getUser(input: GetUserInput, options?): Promise<GetUserOutput> { ... }
```

- **GET** capabilities serialize input as query parameters via `URLSearchParams`.
- **POST** capabilities send input as `JSON.stringify(input)` in the request body.
- All functions accept `options?: { headers?: Record<string, string>; signal?: AbortSignal }`.
- Non-OK responses throw an error with `status`, `code`, and `metadata` properties.

### `generateQueryHook(cap, config?)`

Produces a React hook that auto-fetches on mount/input change:

```ts
generateQueryHook({ name: "getUser", kind: "query", domain: "users", ... })
// → export function useGetUser(input: GetUserInput) {
//     const [data, setData] = useState<GetUserOutput | null>(null);
//     ...
//     return { data, loading, error };
//   }
```

- Uses `useState` + `useEffect` with cancellation.
- Re-fetches when `JSON.stringify(input)` changes.

### `generateMutationHook(cap, config?)`

Produces a React hook for manual invocation (actions, jobs):

```ts
generateMutationHook({ name: "createUser", kind: "action", domain: "users", ... })
// → export function useCreateUser() {
//     ...
//     return { mutate, data, loading, error, reset };
//   }
```

- `mutate(input)` triggers the request and returns the result.
- `reset()` clears data and error state.

### `generateReactHook(cap, config?)`

Dispatches to `generateQueryHook` or `generateMutationHook` based on `cap.kind`:
- `kind === "query"` → query hook
- Anything else → mutation hook

### `generateFlowTrigger(flow, config?)`

Produces a function to start a flow execution:

```ts
interface FlowTriggerInput {
  name: string;
  domain?: string;
  description?: string;
}

generateFlowTrigger({ name: "orderFulfillment", domain: "orders" })
// → export async function startOrderFulfillment(input, options?)
//     : Promise<{ executionId: string; status: string }> { ... }
```

- POSTs to `/api/{domain}/{kebab-name}/start`.

### `generateErrorTypes()`

Produces `PlumbusApiError` interface and `isPlumbusApiError()` type guard — always included in module output.

## Module Generators

### `generateClientModule(capabilities, flows, config?)`

Combines all generators into a single client file:

```ts
const code = generateClientModule(
  [getUser, createUser, deleteUser],
  [{ name: "orderFulfillment", domain: "orders" }],
  { baseUrl: "/api", includeJsDoc: true },
);
// Output: .plumbus/generated/ui/client.ts (written by CLI)
```

Output order: error types → capability types → flow types → client functions → flow triggers.

### `generateHooksModule(capabilities, config?)`

Produces a React hooks file that imports from the client module:

```ts
const code = generateHooksModule([getUser, createUser]);
// Output: .plumbus/generated/ui/hooks.ts (written by CLI)
```

- Auto-imports `useState`, `useEffect` from React.
- Auto-imports types and functions from `./client`.

## URL Routing Convention

| Capability Kind | HTTP Method | URL Pattern |
|----------------|-------------|-------------|
| query | GET | `/api/{domain}/{kebab-name}` |
| action | POST | `/api/{domain}/{kebab-name}` |
| job | POST | `/api/{domain}/{kebab-name}` |
| eventHandler | POST | `/api/{domain}/{kebab-name}` |

Flow triggers always POST to `/api/{domain}/{kebab-name}/start`.

## Internal Helpers

| Helper | Purpose |
|--------|---------|
| `toCamelCase(str)` | Capability function names — `getUser` |
| `toPascalCase(str)` | Type names — `GetUser` |
| `toKebabCase(str)` | URL path segments — `get-user` |
| `httpMethod(kind)` | `"query" → "GET"`, everything else → `"POST"` |
| `capabilityPath(domain, name)` | `/api/{domain}/{kebab-name}` |
