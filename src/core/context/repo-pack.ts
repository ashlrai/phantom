/**
 * Per-job starting pack: rank repo files, CLI-reference lines and recent merged
 * job titles against a goal by plain keyword and path match. Pure and offline:
 * callers supply the file list, reference lines and titles.
 */
export const REPO_PACK_SCHEMA = 'phantom.context-pack.v1';
export const REPO_PACK_MAX_BYTES = 4096;

export interface RepoPackInput {
  goal: string;
  files: readonly string[];
  /** Command rows from docs/CLI-REFERENCE.md (plain text, one per row). */
  commandLines: readonly string[];
  /** Subjects of work merged in the last 7 days. */
  recentTitles: readonly string[];
  maxFiles?: number;
}

export interface RepoPack {
  schema: typeof REPO_PACK_SCHEMA;
  verdict: 'found' | 'unknown';
  keywords: string[];
  files: { path: string; score: number; reason: string }[];
  commands: string[];
  possiblyDone: string[];
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'any', 'all', 'one', 'new', 'add',
  'use', 'make', 'when', 'what', 'each', 'than', 'then', 'them', 'are', 'not', 'can', 'its', 'has', 'have', 'will',
  'should', 'must', 'only', 'also', 'both', 'over', 'under', 'file', 'files', 'code', 'test', 'tests', 'job', 'jobs',
  'repo', 'src', 'docs', 'deliver', 'goal', 'task']);
const SKIP_PATH = /(^|\/)(node_modules|dist|\.git)\//;

export function keywordsOf(text: string, limit = 24): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    seen.add(raw);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3));
}

export function buildRepoPack(input: RepoPackInput): RepoPack {
  const keywords = keywordsOf(input.goal);
  const maxFiles = Math.max(1, Math.min(50, Math.floor(input.maxFiles ?? 12)));
  const files: RepoPack['files'] = [];
  for (const path of input.files) {
    if (SKIP_PATH.test(path)) continue;
    const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    const baseTokens = tokenSet(base);
    const dirTokens = tokenSet(path.slice(0, Math.max(0, path.length - base.length)));
    const hitBase = keywords.filter(k => baseTokens.has(k));
    const hitDir = keywords.filter(k => !baseTokens.has(k) && dirTokens.has(k));
    const score = hitBase.length * 3 + hitDir.length;
    if (score === 0) continue;
    const parts = [hitBase.length ? `name has ${hitBase.join(', ')}` : '', hitDir.length ? `path has ${hitDir.join(', ')}` : ''];
    files.push({ path, score, reason: parts.filter(Boolean).join('; ') });
  }
  files.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));

  const commands = input.commandLines
    .map(line => ({ line, hits: keywords.filter(k => tokenSet(line).has(k)).length }))
    .filter(c => c.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 5)
    .map(c => c.line);

  // Two shared keywords: one shared word is too common to call "already done".
  const possiblyDone = input.recentTitles
    .map(title => ({ title, hits: keywords.filter(k => tokenSet(title).has(k)).length }))
    .filter(t => t.hits >= 2)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 5)
    .map(t => t.title);

  const pack: RepoPack = {
    schema: REPO_PACK_SCHEMA,
    verdict: files.length || commands.length || possiblyDone.length ? 'found' : 'unknown',
    keywords,
    files: files.slice(0, maxFiles),
    commands,
    possiblyDone,
  };
  return fitPack(pack);
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Drop the lowest-ranked rows until the JSON form fits the byte budget. */
function fitPack(pack: RepoPack): RepoPack {
  const out: RepoPack = {
    ...pack,
    commands: pack.commands.map(c => clip(c, 220)),
    possiblyDone: pack.possiblyDone.map(t => clip(t, 160)),
  };
  while (Buffer.byteLength(JSON.stringify(out)) > REPO_PACK_MAX_BYTES && (out.files.length || out.commands.length)) {
    if (out.files.length > 3) out.files.pop();
    else if (out.commands.length > 1) out.commands.pop();
    else if (out.files.length) out.files.pop();
    else out.commands.pop();
  }
  return out;
}

export function renderRepoPack(pack: RepoPack): string {
  if (pack.verdict === 'unknown') {
    return `Context pack: unknown. No file, command or recent job matched${pack.keywords.length ? ` (${pack.keywords.slice(0, 8).join(', ')})` : ''}.\nTry plainer words from a command, panel or file name.\n`;
  }
  const lines = [`Context pack (${pack.keywords.slice(0, 8).join(', ')})`];
  if (pack.possiblyDone.length) lines.push('', 'Possibly already done (check before starting):', ...pack.possiblyDone.map(t => `  - ${t}`));
  if (pack.files.length) lines.push('', 'Start with these files:', ...pack.files.map(f => `  ${f.path}  (${f.reason})`));
  if (pack.commands.length) lines.push('', 'Related commands:', ...pack.commands.map(c => `  ${c}`));
  let text = `${lines.join('\n')}\n`;
  while (Buffer.byteLength(text) > REPO_PACK_MAX_BYTES) text = `${text.slice(0, REPO_PACK_MAX_BYTES - 2).replace(/\n[^\n]*$/, '')}\n`;
  return text;
}

/** Turn `| <code>phm x &lt;y&gt;</code> | desc | ...` rows into plain `phm x <y> - desc`. */
export function commandLinesFromReference(markdown: string): string[] {
  const out: string[] = [];
  for (const row of markdown.split('\n')) {
    if (!row.startsWith('| <code>')) continue;
    const cells = row.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;
    const plain = (s: string) => s.replace(/<\/?code>/g, '').replace(/&#124;/g, '|').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    out.push(`${plain(cells[0]!)} - ${plain(cells[1]!)}`);
  }
  return out;
}
