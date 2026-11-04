/** Read-only: is this draft job already on a git ref? */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { precheckJob, type JobPrecheckGit, type PrecheckFact } from '../core/fleet/job-precheck.js';
import {
  JOB_PRECHECK_BATCH_MAX,
  precheckJobBatch,
  type JobPrecheckBatchCounts,
  type JobPrecheckReport,
} from '../core/fleet/job-precheck-batch.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const execFileAsync = promisify(execFile);
const usage = 'Usage: ashlr fleet job-precheck <file.md|-> [--ref origin/master] [--job-id RQ-ID] [--json]\n' +
  '       ashlr fleet job-precheck --batch <file.md>... [--ref origin/master] [--identity-from-filename] [--json]';
const STDIN_MAX_BYTES = 8000;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export interface JobPrecheckCliDeps {
  git?: JobPrecheckGit;
  resolveRef?: (ref: string, cwd?: string) => Promise<string>;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => AsyncIterable<Uint8Array>;
  cwd?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

async function readDraftStdin(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > STDIN_MAX_BYTES) throw new Error('stdin too large');
    chunks.push(chunk);
  }
  const markdown = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  if (!markdown.trim()) throw new Error('empty stdin');
  return markdown;
}

function isSafeRef(ref: string): boolean {
  return SAFE_REF.test(ref) && !ref.split('/').includes('..') && !ref.includes('//');
}

function gitStderr(err: unknown): string {
  if (!err || typeof err !== 'object' || !('stderr' in err)) return '';
  return String((err as { stderr?: unknown }).stderr ?? '');
}

/** Resolve a ref to one immutable commit before any path probes. */
export async function resolveJobPrecheckRef(ref: string, cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1_048_576, ...(cwd ? { cwd } : {}),
  });
  const oid = stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error('invalid resolved commit');
  return oid;
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
  const evidence = fact.jobIdMatch === undefined ? '' : ` job-id-match=${fact.jobIdMatch === null ? 'unknown' : fact.jobIdMatch}`;
  if (!fact.lastCommit) return `${fact.path} ${state}${evidence}`;
  return `${fact.path} ${state} ${fact.lastCommit.sha} ${fact.lastCommit.subject.replace(/[\r\n]+/g, ' ')}${evidence}`;
}

/** One report per input in input order, then a batch count line. Never deletes, launches or queues. */
async function runPrecheckBatch(
  files: readonly string[],
  ref: string,
  json: boolean,
  resolvedRef: string | null,
  git: JobPrecheckGit,
  deps: JobPrecheckCliDeps,
  identityFromFilename: boolean,
  log: (line: string) => void,
): Promise<number> {
  const result = await precheckJobBatch(files, {
    readFile: deps.readFile ?? ((path: string) => readFile(path, 'utf8')),
    git,
    ...(identityFromFilename ? { resolveJobId: (file: string) => {
      const name = basename(file);
      const jobId = name.endsWith('.md') ? name.slice(0, -3) : '';
      if (!validJobId(jobId)) throw new Error('invalid job ID filename');
      return jobId;
    } } : {}),
  });
  const results = result.entries.map((entry) =>
    entry.report ? { file: entry.file, ...entry.report } : { file: entry.file, error: entry.error });
  const safe = sanitizePublicJson({ schema: 'fleet.job-precheck-batch.v1', ref, resolvedRef, results, counts: result.counts }) as {
    results: Array<{ file: string; error?: string } & Partial<JobPrecheckReport>>;
    counts: JobPrecheckBatchCounts;
  };
  if (json) log(JSON.stringify(safe));
  else {
    log(`snapshot: ${ref} -> ${resolvedRef ?? 'unavailable'}`);
    for (const entry of safe.results) {
      log(`== ${entry.file}`);
      if (entry.error !== undefined) log(`error: ${entry.error}`);
      else {
        for (const fact of entry.facts ?? []) log(factLine(fact));
        log(`verdict: ${entry.verdict}`);
      }
    }
    const counts = safe.counts;
    log(`batch: fresh=${counts.fresh} partly-on-master=${counts['partly-on-master']} ` +
      `likely-done=${counts['likely-done']} errors=${counts.errors}`);
  }
  if (safe.counts.errors > 0) return 2;
  return safe.counts['likely-done'] > 0 ? 3 : 0;
}

export async function cmdFleetJobPrecheck(args: string[], deps: JobPrecheckCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  if (args.includes('--help') || args.includes('-h')) {
    log(`${usage}\nNames src, test, docs, schema and scripts files in the draft, skipping Do not edit and Never touch lines. Exit 3 when every non-test src file is already on the ref and its last commit subject contains bridge(RQ-...). Exit 0 when the draft is fresh or only partly on the ref. Exit 2 on a read or git failure.\n` +
      `Use - for one UTF-8 draft on stdin (maximum 8000 bytes; nonempty). Cannot combine with --batch.\n` +
      `--job-id requires an exact parsed identity in each non-test source path’s last commit. Unknown or unmatched evidence does not rule out earlier commits; a match does not establish semantic correctness. Cannot combine with --batch.\n` +
      `--identity-from-filename is batch-only: each basename must be a valid job ID followed by .md. It checks exact identity in last-commit subjects only; earlier commits may be missed and a match does not establish correctness. Invalid filenames are per-draft errors.\n` +
      `--batch takes 1-${JOB_PRECHECK_BATCH_MAX} draft paths and reports each in input order over a shared fact cache, so a path several drafts name is probed once. A draft that cannot be read or whose git probe fails is reported as an error for that draft and the batch continues; errors are never called fresh. After the per-draft reports a count line tallies fresh, partly-on-master, likely-done and errors. Batch exits 2 when any draft errored, else 3 when any draft is likely-done, else 0. Read-only: never deletes files, launches jobs or writes queue state.`);
    return 0;
  }
  let ref = 'origin/master';
  let json = false;
  let batch = false;
  let identityFromFilename = false;
  const files: string[] = [];
  let sawRef = false;
  let jobId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      if (json) { error(usage); return 2; }
      json = true;
      continue;
    }
    if (arg === '--batch') {
      if (batch) { error(usage); return 2; }
      batch = true;
      continue;
    }
    if (arg === '--identity-from-filename') {
      if (identityFromFilename) { error(usage); return 2; }
      identityFromFilename = true;
      continue;
    }
    if (arg === '--job-id') {
      const value = args[++i];
      if (jobId !== undefined || !value || !validJobId(value)) { error(usage); return 2; }
      jobId = value;
      continue;
    }
    if (arg === '--ref') {
      const value = args[++i];
      if (sawRef || !value || !isSafeRef(value)) { error(usage); return 2; }
      sawRef = true;
      ref = value;
      continue;
    }
    if ((arg !== '-' && arg.startsWith('-')) || arg.trim() === '' || (!batch && files.length > 0)) { error(usage); return 2; }
    files.push(arg);
  }
  if (!batch && identityFromFilename) { error(usage); return 2; }
  if (batch) {
    if (jobId !== undefined || files.includes('-')) { error(usage); return 2; }
    if (files.length === 0 || files.length > JOB_PRECHECK_BATCH_MAX) { error(usage); return 2; }

  }
  const file = files[0];
  if (!file) { error(usage); return 2; }
  let resolvedRef: string | null = null;
  try {
    if (deps.resolveRef || !deps.git) {
      resolvedRef = await (deps.resolveRef ?? resolveJobPrecheckRef)(ref, deps.cwd);
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolvedRef)) throw new Error('invalid resolved commit');
    }
  } catch {
    error(`error: cannot resolve ref ${ref} to a commit`);
    return 2;
  }
  const git = deps.git ?? gitJobProbe(resolvedRef!, deps.cwd);
  if (batch) return runPrecheckBatch(files, ref, json, resolvedRef, git, deps, identityFromFilename, log);
  let markdown: string;
  try {
    markdown = file === '-'
      ? await readDraftStdin((deps.readStdin ?? (() => process.stdin))())
      : await (deps.readFile ?? ((path: string) => readFile(path, 'utf8')))(file);
  } catch {
    error(file === '-' ? 'error: invalid or unreadable stdin (maximum 8000 UTF-8 bytes)' : `error: cannot read ${file}`);
    return 2;
  }
  try {
    const report = await precheckJob(markdown, git, { jobId });
    const safe = sanitizePublicJson(report) as typeof report;
    if (json) log(JSON.stringify(sanitizePublicJson({ schema: 'fleet.job-precheck.v1', ref, resolvedRef, ...safe })));
    else {
      log(`snapshot: ${ref} -> ${resolvedRef ?? 'unavailable'}`);
      if (safe.jobId !== undefined) log(`job-id: ${safe.jobId} (last-commit evidence only; a match does not establish correctness)`);
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
