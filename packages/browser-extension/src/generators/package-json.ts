import type { BrowserExtensionScaffoldConfig, GeneratedFile } from '../types.js';

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

function buildScripts(browsers: ('chrome' | 'firefox')[]): Record<string, string> {
  const hasChrome = browsers.includes('chrome');
  const hasFirefox = browsers.includes('firefox');
  const scripts: Record<string, string> = {
    postinstall: 'wxt prepare',
    compile: 'tsc --noEmit',
  };

  if (hasChrome) {
    scripts.dev = 'wxt';
    scripts['dev:chrome'] = 'wxt';
    scripts.build = 'wxt build';
    scripts['build:chrome'] = 'wxt build';
    scripts.zip = 'wxt zip';
    scripts['zip:chrome'] = 'wxt zip';
  }

  if (hasFirefox) {
    scripts['dev:firefox'] = 'wxt -b firefox';
    scripts['build:firefox'] = 'wxt build -b firefox';
    scripts['zip:firefox'] = 'wxt zip -b firefox';
    if (!hasChrome) {
      scripts.dev = 'wxt -b firefox';
      scripts.build = 'wxt build -b firefox';
      scripts.zip = 'wxt zip -b firefox';
    }
  }

  return scripts;
}

export function generatePackageJson(config: BrowserExtensionScaffoldConfig): GeneratedFile {
  const name = toKebabCase(config.appName);
  const browsers = config.browsers ?? ['chrome', 'firefox'];
  const content = {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: buildScripts(browsers),
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
    },
    devDependencies: {
      '@types/react': '^19.0.0',
      '@types/react-dom': '^19.0.0',
      typescript: '^5.7.0',
      wxt: '^0.20.0',
      '@wxt-dev/module-react': '^1.1.0',
    },
  };

  return {
    path: 'package.json',
    content: `${JSON.stringify(content, null, 2)}\n`,
  };
}
