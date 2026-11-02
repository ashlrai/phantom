/**
 * Read-only: which commit last touched each file the red default branch fails on?
 * Takes the "out" text of the repo's entry in the guardian state
 * (~/.ashlr-runs/guardian/state.json; ASHLR_RUNS_DIR overrides the root), parses
 * lines shaped `path(line,col): error TSnnnn: message`, and asks git for the
 * last commit (sha, subject, "(#N)" PR number) that touched each file.
 * Missing state or a green repo has nothing to blame and prints nothing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseGuardianState } from './fleet-main-red-age.js';

const USAGE = 'usage: ashlr fleet red-blame [--repo <name>] [--json]';
const MAX_ERRORS = 200;
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const defaultStatePath = (): string =>
  join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'guardian', 'state.json');

type Output = { log: (message: string) => void; error: (message: string) => void };
export interface FleetRedBlameDeps {
  output?: Output;
  readFile?: (path: string) => string;
  /** Runs git with these args and returns stdout; may throw. */
  git?: (args: string[]) => string;
}
export interface RedBlameRow {
  file: string; line: number; col: number; code: string; message: string;
  sha: string | null; subject: string | null; pr: number | null;
}
export interface RedBlameReport { v: 1; repo: string; errors: RedBlameRow[] }

const defaultGit = (args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });

/** Parse compiler lines out of the guardian "out" text; other lines are ignored. */
export function parseTscErrors(out: string): Omit<RedBlameRow, 'sha' | 'subject' | 'pr'>[] {
  const rows: Omit<RedBlameRow, 'sha' | 'subject' | 'pr'>[] = [];
  for (const text of out.split(/\r?\n/)) {
    const m = ERROR_LINE.exec(text.trim());
    if (m) rows.push({ file: m[1]!, line: Number(m[2]), col: Number(m[3]), code: m[4]!, message: m[5]! });
    if (rows.length >= MAX_ERRORS) break;
  }
  return rows;
}

/** Last commit touching `file`; null fields when git has no answer. */
function lastCommit(file: string, git: (args: string[]) => string): Pick<RedBlameRow, 'sha' | 'subject' | 'pr'> {
  try {
    const [sha, ...rest] = git(['log', '-1', '--format=%H%n%s', '--', file]).trim().split('\n');
    const subject = rest.join(' ').trim();
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha)) return { sha: null, subject: null, pr: null };
    const pr = /\(#(\d+)\)\s*$/.exec(subject) ?? /\(#(\d+)\)/.exec(subject);
    return { sha, subject: subject || null, pr: pr ? Number(pr[1]) : null };
  } catch { return { sha: null, subject: null, pr: null }; }
}

export async function cmdFleetRedBlame(args: string[], deps: FleetRedBlameDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  let repo = 'phantom';
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { output.log(USAGE); return 0; }
    if (seen.has(arg)) { output.error(`error: duplicate option\n${USAGE}`); return 2; }
    seen.add(arg);
    if (arg === '--repo') {
      const value = args[++i];
      if (!value || !/^[\w.-]+(\/[\w.-]+)?$/.test(value)) { output.error(`error: --repo needs a name\n${USAGE}`); return 2; }
      repo = value;
    } else if (arg === '--json') json = true;
    else { output.error(`error: invalid argument\n${USAGE}`); return 2; }
  }
  let raw: string | null = null;
  try { raw = (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(defaultStatePath()); } catch { /* missing state: nothing to blame */ }
  const state = raw === null ? null : parseGuardianState(raw);
  const key = Object.keys(state ?? {}).find(k => k === repo || k.endsWith(`/${repo}`));
  const out = key ? state![key]!.out : undefined;
  const git = deps.git ?? defaultGit;
  const cache = new Map<string, ReturnType<typeof lastCommit>>();
  const errors: RedBlameRow[] = (typeof out === 'string' ? parseTscErrors(out) : []).map(e => {
    if (!cache.has(e.file)) cache.set(e.file, lastCommit(e.file, git));
    return { ...e, ...cache.get(e.file)! };
  });
  if (json) { if (errors.length) output.log(JSON.stringify({ v: 1, repo: key ?? repo, errors } satisfies RedBlameReport)); return 0; }
  for (const e of errors) {
    const who = e.sha ? `last changed by ${e.sha.slice(0, 8)}${e.pr ? ` (#${e.pr})` : ''} "${e.subject ?? ''}"` : 'no commit found';
    output.log(`${e.file}(${e.line},${e.col}) ${e.code}: ${e.message} — ${who}`);
  }
  return 0;
}
