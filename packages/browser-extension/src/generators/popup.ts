import type { BrowserExtensionScaffoldInput, GeneratedFile } from '../types.js';
import { EDITABLE_HEADER } from './constants.js';
import { escapeHtmlText, escapeJsxText } from './escape.js';
import { selectSampleCapability } from '../sample-capability.js';

function generateAppTsx(input: BrowserExtensionScaffoldInput, sampleMessageKey?: string): string {
  const base = input.config.apiBaseUrl.replace(/\/$/, '');
  const loginUrl = `${base}/api/auth/login`;
  const sample = selectSampleCapability(input.capabilities);
  const appTitleJsx = escapeJsxText(input.config.appName);

  const loginBlock = `
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const response = await fetch(${JSON.stringify(loginUrl)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? 'Login failed');
      }
      const data = (await response.json()) as { token: string; user?: unknown };
      await setAuthToken(data.token, data.user);
      setAuthed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }`;

  let sampleBlock = '';
  if (sample.mode === 'zero-input' && sample.capability && sampleMessageKey) {
    const capLabel = escapeJsxText(sample.capability.name);
    sampleBlock = `
      <section>
        <h2>Sample capability</h2>
        <button type="button" onClick={runSample} disabled={sampleLoading}>
          Call ${capLabel}
        </button>
        {sampleResult ? <pre>{sampleResult}</pre> : null}
      </section>`;
  } else {
    sampleBlock = `
      <section>
        <p>
          No zero-input query capability was found.
          Choose a capability and provide valid input before testing the extension.
        </p>
        <p style={{ fontSize: '0.85rem', color: '#666' }}>
          Deny-by-default access policies can also cause authorization errors on a valid scaffold.
        </p>
      </section>`;
  }

  const runSampleFn =
    sample.mode === 'zero-input' && sampleMessageKey
      ? `
  async function runSample() {
    setSampleLoading(true);
    setSampleResult(null);
    const result = await invoke(${JSON.stringify(sampleMessageKey)}, {});
    setSampleLoading(false);
    if (result.ok) {
      setSampleResult(JSON.stringify(result.data, null, 2));
    } else {
      setSampleResult(\`Error: \${result.error.code} — \${result.error.message}\`);
    }
  }`
      : '';

  return `${EDITABLE_HEADER}
import { useState, useEffect } from 'react';
import { setAuthToken, getAuthState, logout } from '../../src/auth-store.js';
import { invoke } from '../../src/invoke.js';

export function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleResult, setSampleResult] = useState<string | null>(null);

  useEffect(() => {
    void getAuthState().then((s) => setAuthed(s.status === 'authenticated'));
  }, []);
${loginBlock}
${runSampleFn}

  async function handleLogout() {
    await logout();
    setAuthed(false);
  }

  return (
    <main style={{ padding: 16, minWidth: 320 }}>
      <h1>${appTitleJsx}</h1>
      {!authed ? (
        <form onSubmit={handleLogin}>
          <label>
            Email
            <input type="email" value={email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} required />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} required />
          </label>
          {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
          <button type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
        </form>
      ) : (
        <>
          <p>Signed in</p>
          <button type="button" onClick={handleLogout}>Sign out</button>
          ${sampleBlock}
        </>
      )}
    </main>
  );
}
`;
}

export function generatePopupFiles(input: BrowserExtensionScaffoldInput): GeneratedFile[] {
  const appContent = generateAppTsx(input, input.config.sampleMessageKey);
  const title = escapeHtmlText(input.config.appName);

  return [
    {
      path: 'entrypoints/popup/index.html',
      content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
`,
    },
    {
      path: 'entrypoints/popup/main.tsx',
      content: `${EDITABLE_HEADER}
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
`,
    },
    {
      path: 'entrypoints/popup/App.tsx',
      content: appContent,
    },
  ];
}
