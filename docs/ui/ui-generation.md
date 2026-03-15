# UI Code Generation

The `@plumbus/ui` package generates type-safe frontend code from Plumbus capability and flow definitions — API clients, React hooks, authentication helpers, form metadata, and Next.js scaffolds.

## Overview

```
Plumbus Definitions                    Generated Code
                                       
┌──────────────┐    ┌─────────┐    ┌──────────────────┐
│ Capabilities │───▶│ plumbus │───▶│ API Client       │
│              │    │ generate│    │ functions         │
└──────────────┘    │         │    └──────────────────┘
                    │         │    ┌──────────────────┐
┌──────────────┐    │         │───▶│ React Hooks      │
│ Entities     │───▶│         │    │ useQuery/Mutation │
│              │    │         │    └──────────────────┘
└──────────────┘    │         │    ┌──────────────────┐
                    │         │───▶│ Auth Wrappers    │
┌──────────────┐    │         │    │ withAuth()       │
│ Access       │───▶│         │    └──────────────────┘
│ Policies     │    │         │    ┌──────────────────┐
└──────────────┘    │         │───▶│ Form Hints       │
                    └─────────┘    │ validation, types│
                                   └──────────────────┘
```

## CLI Workflow

Use the Plumbus CLI for UI generation:

```bash
plumbus ui generate
plumbus ui nextjs frontend
```

`plumbus ui generate` writes UI modules to `.plumbus/generated/ui/` by default:

```
.plumbus/generated/ui/
├── client.ts
├── hooks.ts
├── auth.ts
└── form-hints.ts
```

`plumbus ui nextjs frontend` scaffolds a Next.js app and also writes generated modules into `frontend/generated/`.

## Core Artifact Generation

```bash
plumbus generate
```

This produces framework-derived artifacts under `.plumbus/generated/`:

```
.plumbus/generated/
├── clients/
│   ├── api.ts
│   └── hooks.ts
├── openapi.json
└── manifest.json
```

These outputs are intended as contract artifacts. For frontend-ready source files, use `plumbus ui generate`.

## API Client Functions

Generated for each capability:

```typescript
// generated/client/getUser.ts
export async function getUser(input: { userId: string }): Promise<{
  id: string;
  name: string;
  email: string;
}> {
  const response = await fetch("/api/users/get-user?" + new URLSearchParams({
    userId: input.userId,
  }));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
```

### Query Capabilities (GET)

```typescript
// Input sent as query parameters
const user = await getUser({ userId: "u-1" });
```

### Action Capabilities (POST)

```typescript
// Input sent as JSON body
const created = await createUser({ name: "Alice", email: "alice@test.com" });
```

## React Hooks

### Query hooks (for queries)

```typescript
// generated/hooks.ts
import { useEffect, useState } from "react";
import { getUser } from "./client";

export function useGetUser(input: { userId: string }) {
  const [data, setData] = useState<{ id: string; name: string; email: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getUser(input)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [JSON.stringify(input)]);

  return { data, loading, error };
}
```

Usage:

```tsx
function UserProfile({ userId }: { userId: string }) {
  const { data, loading, error } = useGetUser({ userId });

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return <div>{data.name}</div>;
}
```

### Mutation hooks (for actions)

```typescript
// generated/hooks.ts
import { useState } from "react";
import { createUser } from "./client";

export function useCreateUser() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<{ userId: string } | null>(null);

  const mutate = async (input: { name: string; email: string }) => {
    setLoading(true);
    setError(null);
    try {
      const result = await createUser(input);
      setData(result);
      return result;
    } catch (err) {
      const nextError = err instanceof Error ? err : new Error(String(err));
      setError(nextError);
      throw nextError;
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setData(null);
    setError(null);
  };

  return { mutate, data, loading, error, reset };
}
```

## Auth Wrappers

Generated from capability access policies:

```typescript
// generated/auth/withAuth.ts
export function withAuth(
  Component: React.ComponentType,
  requirements: {
    roles?: string[];
    scopes?: string[];
  }
) {
  return function AuthGuard(props: any) {
    const { user } = useAuth();
    if (!user) return <Redirect to="/login" />;
    if (requirements.roles && !requirements.roles.some(r => user.roles.includes(r))) {
      return <Forbidden />;
    }
    return <Component {...props} />;
  };
}
```

## Form Hints

Generated from entity field definitions:

```typescript
// generated/forms/userForm.ts
export const userFormHints = {
  name: {
    type: "string",
    required: true,
    label: "Name",
    classification: "personal",
  },
  email: {
    type: "string",
    required: true,
    label: "Email",
    classification: "personal",
    validation: "email",
  },
  tier: {
    type: "enum",
    required: true,
    label: "Tier",
    options: ["free", "pro", "enterprise"],
  },
} as const;
```

## Next.js Template

The `@plumbus/ui` package includes a Next.js App Router template:

```typescript
import { generateNextjsTemplate } from "@plumbus/ui";

const template = generateNextjsTemplate({
  appName: "My App",
  auth: true,
  apiBaseUrl: "http://localhost:3000",
});
[getUser, createUser, listUsers]);
```

Generates:

```
app/
├── layout.tsx
├── page.tsx
├── providers.tsx        # QueryClient + Auth provider
├── users/
│   ├── page.tsx         # List view
│   ├── [id]/
│   │   └── page.tsx     # Detail view
│   └── new/
│       └── page.tsx     # Create form
└── api/                 # Proxy config
```

## Programmatic API

### generateClientFunction

```typescript
import { generateClientFunction } from "@plumbus/ui";

const code = generateClientFunction(getUser);
// Returns TypeScript source code string
```

### generateReactHook

```typescript
import { generateReactHook } from "@plumbus/ui";

const code = generateReactHook(getUser);
// Returns TypeScript source code with React Query hook
```

### generateAuthWrapper

```typescript
import { generateAuthWrapper } from "@plumbus/ui";

const code = generateAuthWrapper({ roles: ["admin"], scopes: ["users:write"] });
```

### generateFormHints

```typescript
import { generateFormHints } from "@plumbus/ui";

const hints = generateFormHints(UserEntity);
```

## Customization

The generated code uses standard patterns compatible with:
- **React Query** (TanStack Query) for data fetching
- **Next.js** App Router for pages
- **Zod** for runtime validation (shared with backend)
- **TypeScript** for full type safety end-to-end

