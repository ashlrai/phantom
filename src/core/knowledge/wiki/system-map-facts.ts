import { z } from 'zod';

import { scrubSecrets } from '../../util/scrub.js';
import { extractImportReferences } from './facts.js';
import { isWikiReadable } from './scan.js';

export const sourcePattern = /\.[cm]?[jt]sx?$/i;
const namePattern = '[A-Za-z_$][\\w$]*';
const declaration = new RegExp(`^(?:export +)?(?:default +)?(?:declare +)?(?:abstract +)?(?:async +)?(?:function\\*?|class|const|let|interface|type|enum) +(${namePattern})`);
const routePattern = /\b(?:app|router|server|fastify|hono)\.(get|post|put|patch|delete|all|use)\(\s*['"](\/[\w/:{}.-]*)['"]/gi;
const apiPattern = /['"](\/api\/[\w/:{}.-]+)['"]/g;
const kind = z.enum(['symbol', 'cli', 'route', 'mcp']);
export const mapFactsSchema = z.object({
  lines: z.number().int().nonnegative(),
  marks: z.array(z.tuple([kind, z.string(), z.number().int().positive()])),
  imports: z.array(z.tuple([z.string(), z.number().int().positive()])),
  limited: z.boolean(),
});
type Facts = z.infer<typeof mapFactsSchema>;
const LIMIT = 512;

export function safeMapPath(file: string): boolean {
  // eslint-disable-next-line no-control-regex
  return file.length <= 500 && !/[\\\u0000-\u001f\u007f\ufffd]/u.test(file) &&
    !/(?:^|\/)[a-f0-9]{32,}(?:[./]|$)/i.test(file) &&
    scrubSecrets(file) === file && isWikiReadable(file);
}

function safeLabel(label: string): boolean {
  return label.length <= 180 && !/[a-f0-9]{32,}/i.test(label) && scrubSecrets(label) === label;
}

export function extractMapFacts(source: string, file: string): Facts {
  // Mask comments and template literals without moving any source coordinates.
  const text = source.replace(/"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    match => match[0] === '/' || match.charCodeAt(0) === 96 ? match.replace(/[^\r\n]/g, ' ') : match);
  const rows = text.split('\n');
  const lines = rows.length - Number(rows.at(-1) === '');
  const marks: Facts['marks'] = [];
  let limited = false;
  const add = (kind: Facts['marks'][number][0], name: string | undefined, row: number) => {
    if (!name || !safeLabel(name)) return;
    if (marks.length >= LIMIT) limited = true;
    else marks.push([kind, name, row]);
  };
  const cli = file === 'src/cli/index.ts' || file === 'src/cli/wiki.ts';
  const mcp = /^src\/(?:mcp\/|core\/mcp-native)/.test(file);
  const verse = /^src\/core\/(?:verse|web)\//.test(file);
  for (let i = 0; i < lines; i++) {
    const row = rows[i]!;
    add('symbol', declaration.exec(row)?.[1], i + 1);
    if (cli) add('cli', (file.endsWith('/index.ts') ? /^ {6}case ['"]([\w-]+)['"]:/ : /^ {4}case ['"]([\w-]+)['"]:/).exec(row)?.[1], i + 1);
    if (mcp) add('mcp', /^\s*(?:\{\s*)?name:\s*['"]([\w-]+)['"]\s*[,}]/.exec(row)?.[1], i + 1);
    for (const match of row.matchAll(routePattern)) add('route', `${match[1]!.toUpperCase()} ${match[2]}`, i + 1);
    if (verse && /(?:prefixes:|(?:path|pathname)\s*===|(?:path|pathname)\.startsWith\()/.test(row)) {
      for (const match of row.matchAll(apiPattern)) add('route', match[1], i + 1);
    }
    if (verse) add('route', /^export const \w+_PATH\s*=\s*['"](\/api\/[\w/:{}.-]+)['"]/.exec(row)?.[1], i + 1);
  }
  const imports = extractImportReferences(text, file)
    .filter(({ specifier }) => /^(?:\.{1,2}\/|[@~]\/)[\w./@+-]+$/.test(specifier) && safeLabel(specifier));
  return {
    lines,
    marks,
    imports: imports.slice(0, LIMIT).map(({ specifier, line }) => [specifier, line]),
    limited: limited || imports.length > LIMIT,
  };
}

export function mapFactsKey(file: string): string {
  if (file === 'src/cli/index.ts' || file === 'src/cli/wiki.ts') return file;
  if (/^src\/(?:mcp\/|core\/mcp-native)/.test(file)) return 'mcp';
  if (/^src\/core\/(?:verse|web)\//.test(file)) return 'verse';
  return 'source';
}
