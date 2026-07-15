// ── plumbus translation ──
// Manage translation catalogs: scaffold, export, import, status

import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TranslationDefinition } from '../../types/translation.js';
import { computeStatus, formatTranslationStatus } from '../../translations/status.js';
import { discoverResources } from '../discover.js';
import {
  translationTemplate,
  localeFolderTranslationTemplate,
  localeMessagesTemplate,
} from '../templates/resources.js';
import { findPlumbusProjectRoot, resolvePathWithinProject } from '../project-root.js';
import {
  error,
  exists,
  info,
  resolvePath,
  success,
  toKebabCase,
  warn,
  writeFile,
} from '../utils.js';

// ── XLIFF 2.0 Serialization ──

function toXliff(
  namespace: string,
  sourceLocale: string,
  targetLocale: string,
  sourceMessages: Record<string, string>,
  targetMessages: Record<string, string>,
): string {
  const units = Object.keys(sourceMessages)
    .sort()
    .map((key) => {
      const source = escapeXml(sourceMessages[key] ?? '');
      const target = escapeXml(targetMessages[key] ?? '');
      return `    <unit id="${escapeXml(key)}">
      <notes>
        <note category="namespace">${escapeXml(namespace)}</note>
      </notes>
      <segment>
        <source>${source}</source>
        <target>${target}</target>
      </segment>
    </unit>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0"
       srcLang="${sourceLocale}" trgLang="${targetLocale}">
  <file id="${namespace}">
${units}
  </file>
</xliff>
`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(str: string): string {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

// ── XLIFF 2.0 Parser (simple regex-based for zero-dependency) ──

interface XliffEntry {
  id: string;
  target: string;
}

function parseXliff(xml: string): { targetLocale: string; fileId: string; entries: XliffEntry[] } {
  const trgLangMatch = xml.match(/trgLang="([^"]+)"/);
  const fileIdMatch = xml.match(/<file\s+id="([^"]+)"/);
  const targetLocale = trgLangMatch?.[1] ?? '';
  const fileId = fileIdMatch?.[1] ?? '';

  const entries: XliffEntry[] = [];
  const unitRegex = /<unit\s+id="([^"]+)"[\s\S]*?<target>([\s\S]*?)<\/target>/g;
  for (const match of xml.matchAll(unitRegex)) {
    const id = match[1];
    const target = match[2];
    if (id && target !== undefined) {
      entries.push({ id: unescapeXml(id), target: unescapeXml(target) });
    }
  }

  return { targetLocale, fileId, entries };
}

// ── JSON Flattening ──

function flattenToJson(
  definitions: TranslationDefinition[],
  locale: string,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const def of definitions) {
    const messages = def.messages[locale];
    if (!messages) continue;
    for (const [key, value] of Object.entries(messages)) {
      flat[`${def.name}.${key}`] = value;
    }
  }
  return flat;
}

export function registerTranslationCommand(program: Command): void {
  const cmd = program.command('translation').description('Manage translation catalogs');

  // ── plumbus translation new <name> ──
  cmd
    .command('new <name>')
    .description('Scaffold a new translation catalog')
    .option(
      '--locale-folders',
      'Scaffold per-locale message files under en/ and he/ with a thin assembler',
    )
    .action((name: string, opts: { localeFolders?: boolean }) => {
      const kebab = toKebabCase(name);

      if (opts.localeFolders) {
        const assemblerPath = resolvePath('app', 'translations', `${kebab}.translation.ts`);
        const enPath = resolvePath('app', 'translations', 'en', `${kebab}.messages.ts`);
        const hePath = resolvePath('app', 'translations', 'he', `${kebab}.messages.ts`);

        if (exists(assemblerPath) || exists(enPath) || exists(hePath)) {
          error(`Translation "${kebab}" already exists`);
          process.exit(1);
        }

        writeFile(enPath, localeMessagesTemplate());
        writeFile(hePath, localeMessagesTemplate());
        writeFile(assemblerPath, localeFolderTranslationTemplate(name));
        success(`Created translation (locale folders):`);
        info(`  app/translations/en/${kebab}.messages.ts`);
        info(`  app/translations/he/${kebab}.messages.ts`);
        info(`  app/translations/${kebab}.translation.ts`);
        return;
      }

      const filePath = resolvePath('app', 'translations', `${kebab}.translation.ts`);

      if (exists(filePath)) {
        error(`Translation "${kebab}" already exists`);
        process.exit(1);
      }

      writeFile(filePath, translationTemplate(name));
      success(`Created translation: app/translations/${kebab}.translation.ts`);
    });

  // ── plumbus translation export ──
  cmd
    .command('export')
    .description('Export translations for external translators')
    .option('--format <format>', 'Output format: json or xliff', 'json')
    .option('--locale <locale>', 'Export only this locale (default: all)')
    .option('--out-dir <path>', 'Output directory', '.plumbus/translations')
    .action(async (opts: { format: string; locale?: string; outDir: string }) => {
      const resources = await discoverResources();
      const definitions = resources.translations;

      if (definitions.length === 0) {
        error('No translation definitions found in app/translations/');
        process.exit(1);
      }

      const outDir = resolvePath(opts.outDir);
      const allLocales = [...new Set(definitions.flatMap((d) => d.locales))];
      const targetLocales = opts.locale ? [opts.locale] : allLocales;

      if (opts.format === 'xliff') {
        // Export XLIFF 2.0 files: one per target locale per namespace
        const defaultLocale = definitions[0]?.defaultLocale ?? 'en';
        for (const locale of targetLocales) {
          if (locale === defaultLocale) continue; // Source locale doesn't need XLIFF
          for (const def of definitions) {
            const sourceMessages = def.messages[def.defaultLocale] ?? {};
            const targetMessages = def.messages[locale] ?? {};
            const xliff = toXliff(
              def.name,
              def.defaultLocale,
              locale,
              sourceMessages,
              targetMessages,
            );
            const filePath = path.join(outDir, `${def.name}.${locale}.xlf`);
            writeFile(filePath, xliff);
          }
        }
        success(`Exported XLIFF 2.0 files to ${opts.outDir}/`);
      } else {
        // Export flat JSON: one file per locale
        for (const locale of targetLocales) {
          const flat = flattenToJson(definitions, locale);
          const filePath = path.join(outDir, `${locale}.json`);
          writeFile(
            filePath,
            `${JSON.stringify(flat, null, 2)}
`,
          );
        }
        success(`Exported JSON files to ${opts.outDir}/`);
      }
    });

  // ── plumbus translation import ──
  cmd
    .command('import')
    .description('Import translations from external files')
    .option(
      '--format <format>',
      'Input format: json or xliff (auto-detected from extension if omitted)',
    )
    .option('--file <path>', 'Import a single file')
    .option('--dir <path>', 'Import all files from a directory')
    .action(async (opts: { format?: string; file?: string; dir?: string }) => {
      if (!opts.file && !opts.dir) {
        error('Specify --file or --dir');
        process.exit(1);
      }

      const projectRoot = findPlumbusProjectRoot();
      if (!projectRoot) {
        error('Not in a Plumbus project — run from project root (config/app.config.ts required)');
        process.exit(1);
      }

      const files: string[] = [];
      try {
        if (opts.file) {
          files.push(resolvePathWithinProject(opts.file, projectRoot));
        }
        if (opts.dir) {
          const dirPath = resolvePathWithinProject(opts.dir, projectRoot);
          if (fs.existsSync(dirPath)) {
            const entries = fs.readdirSync(dirPath);
            for (const entry of entries) {
              if (entry.endsWith('.json') || entry.endsWith('.xlf')) {
                files.push(path.join(dirPath, entry));
              }
            }
          }
        }
      } catch (pathErr) {
        error(pathErr instanceof Error ? pathErr.message : String(pathErr));
        process.exit(1);
      }

      if (files.length === 0) {
        error('No importable files found (.json or .xlf)');
        process.exit(1);
      }

      const resources = await discoverResources();
      const definitions = resources.translations;
      let updatedCount = 0;

      for (const filePath of files) {
        const ext = path.extname(filePath);
        const format = opts.format ?? (ext === '.xlf' ? 'xliff' : 'json');
        const content = fs.readFileSync(filePath, 'utf-8');

        if (format === 'xliff') {
          const parsed = parseXliff(content);
          const def = definitions.find((d) => d.name === parsed.fileId);
          if (!def) {
            info(`Skipping ${path.basename(filePath)}: no matching namespace "${parsed.fileId}"`);
            continue;
          }
          const localeMessages = def.messages[parsed.targetLocale];
          if (!localeMessages) {
            info(
              `Skipping ${path.basename(filePath)}: locale "${parsed.targetLocale}" not declared`,
            );
            continue;
          }
          for (const entry of parsed.entries) {
            if (entry.target && entry.id in localeMessages) {
              localeMessages[entry.id] = entry.target;
              updatedCount++;
            }
          }
        } else {
          // JSON format: flat dot-notation keys
          const flat = JSON.parse(content) as Record<string, string>;
          for (const [fullKey, value] of Object.entries(flat)) {
            const dotIndex = fullKey.indexOf('.');
            if (dotIndex === -1) continue;
            const namespace = fullKey.substring(0, dotIndex);
            const messageKey = fullKey.substring(dotIndex + 1);
            const def = definitions.find((d) => d.name === namespace);
            if (!def) continue;

            // Detect locale from filename (e.g. "he.json")
            const baseName = path.basename(filePath, '.json');
            const localeMessages = def.messages[baseName];
            if (!localeMessages) continue;
            if (messageKey in localeMessages) {
              localeMessages[messageKey] = value;
              updatedCount++;
            }
          }
        }
      }

      success(`Imported ${updatedCount} translation entries from ${files.length} file(s)`);
      info(
        'Note: Imported translations are held in memory. To persist, re-export or update source files manually.',
      );
    });

  // ── plumbus translation status ──
  cmd
    .command('status')
    .description('Report translation coverage per namespace and locale')
    .option('--json', 'Output as JSON for CI integration')
    .action(async (opts: { json?: boolean }) => {
      const resources = await discoverResources();
      const definitions = resources.translations;

      if (definitions.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({ namespaces: [], incomplete: 0 }));
        } else {
          info('No translation definitions found in app/translations/');
        }
        return;
      }

      const status = computeStatus(definitions);

      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        for (const line of formatTranslationStatus(status)) {
          console.log(line);
        }

        if (status.incomplete > 0) {
          warn(`\n${status.incomplete} locale(s) have incomplete translations`);
        } else {
          success('\nAll translations are complete');
        }
      }

      if (status.incomplete > 0) {
        process.exit(1);
      }
    });
}
