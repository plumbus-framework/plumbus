import type { GeneratedFile } from '../types.js';

export function generateTsConfig(): GeneratedFile {
  return {
    path: 'tsconfig.json',
    content: JSON.stringify(
      {
        extends: './.wxt/tsconfig.json',
        compilerOptions: {
          jsx: 'react-jsx',
          strict: true,
        },
      },
      null,
      2,
    ),
  };
}
