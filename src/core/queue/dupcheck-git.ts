/**
 * `phm jobs dupcheck`: is the work a job prompt asks for already on master? Git only, no network.
 *
 * Pulls the concrete anchors out of the prompt (commands like `phm x y`, file paths, exported names in
 * backticks) and looks each one up in the repo at origin/master with `git cat-file` and `git grep`.
 * Unlike `phm queue dupcheck` (which reads the local CLI list and job records) this reads any repo's
 * committed tree, so it also works for jobs aimed at another checkout. It only reports; it never drops a job.
 *
 *   likely done      every anchor is on master
 *   partly on master some anchors are, some are not (both lists are returned)
 *   new              none is on master, or the prompt names nothing to look up
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { extractJobPaths } from '../fleet/job-precheck.js';
import { commandNouns, dupcheckGoal } from './dupcheck.js';

const run = promisify(execFile);
export const GIT_DUPCHECK_SCHEMA = 'jobs.dupcheck.v1';
export type GitDupcheckVerdict = 'new' | 'partly on master' | 'likely done';
export type GitAnchorKind = 'command' | 'flag' | 'file' | 'name';
export interface GitAnchor { kind: GitAnchorKind; text: string; found: boolean; where: string | null }
export interface GitDupcheckReport {
  schema: typeof GIT_DUPCHECK_SCHEMA;
  verdict: GitDupcheckVerdict;
  summary: string;
  /** The ref that was searched, e.g. origin/master; null when the repo has none of the candidates. */
  ref: string | null;
  anchors: GitAnchor[];
  found: string[];
  missing: string[];
}

const NAME_RE = /`([A-Za-z_$][\w$]*)`/g;
const FLAG_RE = /(?<![\w-])(--[a-z][a-z0-9-]*)/g;
const MAX_ANCHORS = 40;

/** Backticked identifiers that look like exports (camelCase or PascalCase, not a plain word or a flag). */
export function exportedNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(NAME_RE)) if (/[a-z]/.test(m[1]!) && /[A-Z]/.test(m[1]!.slice(1)) && m[1]!.length > 4) out.add(m[1]!);
  return [...out];
}

async function git(repo: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try { return { ok: true, out: (await run('git', ['-C', repo, ...args], { maxBuffer: 8_000_000, timeout: 5_000 })).stdout }; }
  catch (error) { return { ok: (error as { code?: number }).code === 1, out: '' }; }
}

/** origin/master, else master, else HEAD: bridge worktrees often have no origin remote. */
export async function resolveRef(repo: string): Promise<string | null> {
  for (const ref of ['origin/master', 'master', 'HEAD']) if ((await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).out.trim()) return ref;
  return null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pure shape of the report from checked anchors. */
export function gitDupcheckVerdict(anchors: GitAnchor[], ref: string | null): GitDupcheckReport {
  const found = anchors.filter(a => a.found).map(a => a.text), missing = anchors.filter(a => !a.found).map(a => a.text);
  const at = ref ?? 'the repo';
  let verdict: GitDupcheckVerdict, summary: string;
  if (!anchors.length) { verdict = 'new'; summary = 'New: the prompt names no command, file or name to look up. Launch it.'; }
  else if (!found.length) { verdict = 'new'; summary = `New: none of ${missing.join(', ')} is on ${at}. Launch it.`; }
  else if (!missing.length) { verdict = 'likely done'; summary = `Likely done: ${found.join(', ')} already on ${at}. Check them before launching.`; }
  else { verdict = 'partly on master'; summary = `Partly on master: ${found.join(', ')} exist; ${missing.join(', ')} not found. Build only what is missing.`; }
  return { schema: GIT_DUPCHECK_SCHEMA, verdict, summary, ref, anchors, found, missing };
}

/** The call for the router and precheck: prompt text in, typed verdict out. */
export async function gitDupcheck(promptText: string, opts: { repo?: string } = {}): Promise<GitDupcheckReport> {
  const repo = resolve(opts.repo ?? process.cwd());
  const ref = await resolveRef(repo);
  const goal = dupcheckGoal(promptText);
  const anchors: GitAnchor[] = [];
  if (!ref) return gitDupcheckVerdict([], null);

  const firstHit = async (patterns: string[], extended: boolean): Promise<string | null> => {
    const args = ['grep', '-l', '-I', extended ? '-E' : '-F', ...patterns.flatMap(p => ['-e', p]), ref, '--'];
    const hit = (await git(repo, args)).out.split('\n')[0]?.trim();
    return hit ? hit.replace(`${ref}:`, '') : null;
  };

  const flags = [...new Set([...goal.matchAll(FLAG_RE)].map(m => m[1]!))];
  for (const noun of commandNouns(goal)) {
    const words = noun.split(' ').map(escapeRe).join('[ -]');
    // The command as typed (`phm x y`), or a help-table row that starts with it (cmd: 'x y ...).
    const where = await firstHit([`(phm|ashlr) ${words}([^a-z0-9-]|$)`, `(cmd|usage): '(phm |ashlr )?${words}([^a-z0-9-]|$)`], true);
    anchors.push({ kind: 'command', text: `phm ${noun}`, found: where !== null, where });
    if (where) for (const flag of flags) {
      const at = (await git(repo, ['grep', '-l', '-F', '-e', flag, ref, '--', where])).out.trim();
      anchors.push({ kind: 'flag', text: `${flag} (${noun})`, found: at !== '', where: at ? where : null });
    }
  }
  for (const path of extractJobPaths(goal)) {
    const there = (await git(repo, ['cat-file', '-e', `${ref}:${path}`])).ok;
    anchors.push({ kind: 'file', text: path, found: there, where: there ? path : null });
  }
  for (const name of exportedNames(goal)) {
    const where = await firstHit([`export (declare )?(async )?(function\\*?|const|let|class|interface|type|enum) ${escapeRe(name)}([^A-Za-z0-9_$]|$)`], true);
    anchors.push({ kind: 'name', text: name, found: where !== null, where });
  }
  return gitDupcheckVerdict(anchors.slice(0, MAX_ANCHORS), ref);
}

export async function gitDupcheckFile(promptFile: string, opts: { repo?: string } = {}): Promise<GitDupcheckReport> {
  return gitDupcheck(readFileSync(promptFile, 'utf8'), opts);
}

export function gitDupcheckLines(report: GitDupcheckReport): string[] {
  return [report.verdict, report.summary, ...report.anchors.map(a => `  ${a.found ? 'found  ' : 'missing'} ${a.text}${a.where ? `  (${a.where})` : ''}`)];
}
