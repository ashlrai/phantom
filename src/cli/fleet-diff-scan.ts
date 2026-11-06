import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export interface DiffScanFinding { file: string; line: number; kind: 'key prefix' | 'long hex' | 'long base64' }
export interface DiffScanReport { schema: 'fleet.diff-scan.v1'; findings: DiffScanFinding[] }
const USAGE = 'ashlr fleet diff-scan [--dir <path>] --json';

/** Heuristics, not proof of a secret. Never return the matched text. */
function keyKind(line: string): DiffScanFinding['kind'] | null {
  if (/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{16,})\b/.test(line)) return 'key prefix';
  if (/(?:^|[^A-Za-z0-9])[a-fA-F0-9]{32,}(?![A-Za-z0-9])/.test(line)) return 'long hex';
  for (const match of line.matchAll(/[A-Za-z0-9+/_-]{40,}={0,2}/g)) {
    if (/[A-Z]/.test(match[0]) && /[a-z]/.test(match[0]) && /[0-9+/]/.test(match[0])) return 'long base64';
  }
  return null;
}

/** File is supplied separately so quoted paths and patch-looking content are safe. */
export function scanAddedLines(file: string, patch: string): DiffScanFinding[] {
  const findings: DiffScanFinding[] = [];
  let line = 0;
  let inHunk = false;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) { line = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (row.startsWith('+')) {
      const kind = keyKind(row.slice(1));
      if (kind) findings.push({ file, line, kind });
      line++;
    } else if (row.startsWith(' ')) line++;
  }
  return findings;
}

/** Tracked staged and unstaged changes compared with HEAD; no hooks or diff drivers. */
export function readDiffScan(dir: string): DiffScanReport {
  const git = (args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', resolve(dir), ...args], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const files = git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--']).split('\0').filter(Boolean);
  const findings = files.flatMap(file => scanAddedLines(file, git([
    '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
    '--unified=0', 'HEAD', '--', file,
  ])));
  return { schema: 'fleet.diff-scan.v1', findings };
}

export async function cmdFleetDiffScan(args: string[]): Promise<number> {
  let dir = process.cwd();
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log(`${USAGE}\nFind possible keys in added lines. Values stay hidden. Reads tracked changes against HEAD; untracked files are not included. Findings exit 0; read errors exit 1; bad options exit 2.`);
      return 0;
    }
    if (seen.has(arg)) { console.error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--dir' && args[i + 1] && !args[i + 1]!.startsWith('--')) dir = args[++i]!;
    else if (arg !== '--json') { console.error(USAGE); return 2; }
  }
  if (!seen.has('--json')) { console.error(USAGE); return 2; }
  try { console.log(JSON.stringify(readDiffScan(dir))); return 0; }
  catch { console.error('Could not read the git diff. Choose a worktree with a HEAD commit.'); return 1; }
}
