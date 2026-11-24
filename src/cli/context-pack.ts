import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildRepoPack, commandLinesFromReference, renderRepoPack } from '../core/context/repo-pack.js';

export const CONTEXT_PACK_USAGE = 'Usage: phm context pack <goal-text|prompt-file> [--max-files 12] [--json]\nRanks repo files, commands and the last 7 days of merged job titles against the goal. Read-only, offline.';

export interface ContextPackDeps {
  cwd?: string;
  files?: () => string[];
  titles?: () => string[];
  reference?: () => string;
  out?: (s: string) => void;
}

function git(cwd: string, args: string[]): string[] {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch { return []; }
}

/** Exit 0 pack printed (unknown included), 2 bad usage. */
export function cmdContextPack(args: string[], deps: ContextPackDeps = {}): number {
  const out = deps.out ?? ((s: string) => console.log(s));
  if (args.includes('--help') || args.includes('-h')) { out(CONTEXT_PACK_USAGE); return 0; }
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { 'max-files': { type: 'string' }, json: { type: 'boolean' } } });
  } catch { out(CONTEXT_PACK_USAGE); return 2; }
  const maxFiles = parsed.values['max-files'] === undefined ? 12 : Number(parsed.values['max-files']);
  const input = parsed.positionals.join(' ').trim();
  if (!input || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 50) { out(CONTEXT_PACK_USAGE); return 2; }
  const cwd = deps.cwd ?? process.cwd();
  const isFile = parsed.positionals.length === 1 && existsSync(input) && statSync(input).isFile();
  const goal = isFile ? readFileSync(input, 'utf8').slice(0, 64 * 1024) : input;
  const refPath = `${cwd}/docs/CLI-REFERENCE.md`;
  const reference = deps.reference ? deps.reference() : existsSync(refPath) ? readFileSync(refPath, 'utf8') : '';
  const pack = buildRepoPack({
    goal,
    maxFiles,
    files: (deps.files ?? (() => git(cwd, ['ls-files'])))(),
    commandLines: commandLinesFromReference(reference),
    recentTitles: (deps.titles ?? (() => git(cwd, ['log', '--since=7.days', '--format=%s'])))(),
  });
  out(parsed.values.json ? JSON.stringify(pack) : renderRepoPack(pack).trimEnd());
  return 0;
}
