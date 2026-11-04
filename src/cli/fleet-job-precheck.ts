/** Read-only: is this draft job already on a git ref? */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { precheckJob, type JobPrecheckGit, type PrecheckFact } from '../core/fleet/job-precheck.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const execFileAsync = promisify(execFile);
const usage = 'Usage: ashlr fleet job-precheck <file.md> [--ref origin/master] [--json]';
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export interface JobPrecheckCliDeps {
  git?: JobPrecheckGit;
  readFile?: (path: string) => Promise<string>;
  cwd?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

function isSafeRef(ref: string): boolean {
  return SAFE_REF.test(ref) && !ref.split('/').includes('..') && !ref.includes('//');
}

function gitStderr(err: unknown): string {
  if (!err || typeof err !== 'object' || !('stderr' in err)) return '';
  return String((err as { stderr?: unknown }).stderr ?? '');
}

/** `git cat-file -e <ref>:<path>` and `git log -1` via execFile. Never a shell string. */
export function gitJobProbe(ref: string, cwd?: string): JobPrecheckGit {
  const opts = { encoding: 'utf8' as const, timeout: 15_000, maxBuffer: 1_048_576, ...(cwd ? { cwd } : {}) };
  return {
    async exists(path: string): Promise<boolean> {
      try {
        await execFileAsync('git', ['cat-file', '-e', `${ref}:${path}`], opts);
        return true;
      } catch (err) {
        // A missing path is a fact. A bad ref or a broken git must not look like "fresh".
        if (/does not exist|exists on disk, but not in/i.test(gitStderr(err))) return false;
        throw err;
      }
    },
    async lastCommit(path: string): Promise<{ sha: string; subject: string } | null> {
      const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%h%x09%s', ref, '--', path], opts);
      const line = String(stdout).split(/\r?\n/, 1)[0] ?? '';
      const tab = line.indexOf('\t');
      if (tab <= 0) return null;
      const sha = line.slice(0, tab);
      const subject = line.slice(tab + 1);
      if (!/^[0-9a-f]{4,40}$/i.test(sha) || subject.length === 0) return null;
      return { sha, subject };
    },
  };
}

function factLine(fact: PrecheckFact): string {
  const state = fact.onMaster ? 'on-master' : 'missing';
  if (!fact.lastCommit) return `${fact.path} ${state}`;
  return `${fact.path} ${state} ${fact.lastCommit.sha} ${fact.lastCommit.subject.replace(/[\r\n]+/g, ' ')}`;
}

export async function cmdFleetJobPrecheck(args: string[], deps: JobPrecheckCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  if (args.includes('--help') || args.includes('-h')) {
    log(`${usage}\nNames src, test, docs, schema and scripts files in the draft, skipping Do not edit and Never touch lines. Exit 3 when every non-test src file is already on the ref and its last commit subject contains bridge(RQ-...). Exit 0 when the draft is fresh or only partly on the ref.`);
    return 0;
  }
  let ref = 'origin/master';
  let json = false;
  let file: string | undefined;
  let sawRef = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      if (json) { error(usage); return 2; }
      json = true;
      continue;
    }
    if (arg === '--ref') {
      const value = args[++i];
      if (sawRef || !value || !isSafeRef(value)) { error(usage); return 2; }
      sawRef = true;
      ref = value;
      continue;
    }
    if (arg.startsWith('-') || file) { error(usage); return 2; }
    file = arg;
  }
  if (!file) { error(usage); return 2; }
  let markdown: string;
  try {
    markdown = await (deps.readFile ?? ((path: string) => readFile(path, 'utf8')))(file);
  } catch {
    error(`error: cannot read ${file}`);
    return 2;
  }
  try {
    const report = await precheckJob(markdown, deps.git ?? gitJobProbe(ref, deps.cwd));
    const safe = sanitizePublicJson(report) as typeof report;
    if (json) log(JSON.stringify(sanitizePublicJson({ schema: 'fleet.job-precheck.v1', ...safe })));
    else {
      for (const fact of safe.facts) log(factLine(fact));
      log(`verdict: ${safe.verdict}`);
    }
    return safe.verdict === 'likely-done' ? 3 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : 'git precheck failed';
    error(`error: ${message.slice(0, 300)}`);
    return 2;
  }
}
