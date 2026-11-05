/** Read-only: is this draft job already on a git ref? */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { precheckJob, type JobPrecheckGit, type PrecheckFact } from '../core/fleet/job-precheck.js';
import {
  JOB_PRECHECK_BATCH_MAX,
  precheckJobBatch,
  type JobPrecheckBatchCounts,
  type JobPrecheckCollision,
  type JobPrecheckReport,
} from '../core/fleet/job-precheck-batch.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const execFileAsync = promisify(execFile);
const usage = 'Usage: ashlr fleet job-precheck <file.md|-> [--ref origin/master] [--job-id RQ-ID] [--json]\n' +
  '       ashlr fleet job-precheck --batch <file.md>...|- [--ref origin/master] [--json]';
const STDIN_MAX_BYTES = 8000;
const BATCH_STDIN_MAX_BYTES = 200_000;
const LABEL_MAX_BYTES = 200;
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

async function readStdinText(source: AsyncIterable<Uint8Array>, limit: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('stdin too large');
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

async function readDraftStdin(source: AsyncIterable<Uint8Array>): Promise<string> {
  const markdown = await readStdinText(source, STDIN_MAX_BYTES);
  if (!markdown.trim()) throw new Error('empty stdin');
  return markdown;
}

async function readBatchStdin(source: AsyncIterable<Uint8Array>): Promise<Map<string, string>> {
  const value: unknown = JSON.parse(await readStdinText(source, BATCH_STDIN_MAX_BYTES));
  if (!Array.isArray(value) || value.length < 1 || value.length > JOB_PRECHECK_BATCH_MAX) throw new Error('invalid batch');
  const drafts = new Map<string, string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).length !== 2 || !Object.hasOwn(item, 'label') || !Object.hasOwn(item, 'markdown')) throw new Error('invalid entry');
    const { label, markdown } = item as Record<string, unknown>;
    if (typeof label !== 'string' || !label.trim() || Buffer.byteLength(label, 'utf8') > LABEL_MAX_BYTES || drafts.has(label) ||
        typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown, 'utf8') > STDIN_MAX_BYTES) throw new Error('invalid draft');
    drafts.set(label, markdown);
  }
  return drafts;
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
    async lastCommit(path: string): Promise<{ sha: string; subject: string; filesChanged: number | null } | null> {
      const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%h%x09%s', ref, '--', path], opts);
      const line = String(stdout).split(/\r?\n/, 1)[0] ?? '';
      const tab = line.indexOf('\t');
      if (tab <= 0) return null;
      const sha = line.slice(0, tab);
      const subject = line.slice(tab + 1);
      if (!/^[0-9a-f]{4,40}$/i.test(sha) || subject.length === 0) return null;
      let filesChanged: number | null = null;
      try {
        const { stdout: names } = await execFileAsync('git', ['show', '--format=', '--name-only', '-z', sha], {
          ...opts, maxBuffer: 8 * 1024 * 1024,
        });
        filesChanged = names.split('\0').filter(Boolean).length;
      } catch { /* Unknown counts preserve existing behavior. */ }
      return { sha, subject, filesChanged };
    },
  };
}

function factLine(fact: PrecheckFact): string {
  const state = fact.onMaster ? 'on-master' : 'missing';
  const evidence = fact.jobIdMatch === undefined ? '' : ` job-id-match=${fact.jobIdMatch === null ? 'unknown' : fact.jobIdMatch}`;
  if (!fact.lastCommit) return `${fact.path} ${state}${evidence}`;
  return `${fact.path} ${state} ${fact.lastCommit.sha} ${fact.lastCommit.subject.replace(/[\r\n]+/g, ' ')}${fact.bulk ? ' bulk-commit' : ''}${evidence}`;
}

/** One report per input in input order, then a batch count line. Never deletes, launches or queues. */
async function runPrecheckBatch(
  files: readonly string[],
  ref: string,
  json: boolean,
  resolvedRef: string | null,
  git: JobPrecheckGit,
  deps: JobPrecheckCliDeps,
  log: (line: string) => void,
): Promise<number> {
  const result = await precheckJobBatch(files, {
    readFile: deps.readFile ?? ((path: string) => readFile(path, 'utf8')),
    git,
  });
  const results = result.entries.map((entry) =>
    entry.report ? { file: entry.file, ...entry.report } : { file: entry.file, error: entry.error });
  const safe = sanitizePublicJson({ schema: 'fleet.job-precheck-batch.v1', ref, resolvedRef, results, counts: result.counts, collisions: result.collisions }) as {
    results: Array<{ file: string; error?: string } & Partial<JobPrecheckReport>>;
    counts: JobPrecheckBatchCounts;
    collisions: JobPrecheckCollision[];
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
    for (const collision of safe.collisions) {
      log(`collision (evidence only): ${collision.path} — ${collision.files.join(", ")}`);
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
      `Use - for one UTF-8 draft on stdin (maximum 8000 bytes; nonempty). With --batch -, stdin is a UTF-8 JSON array of 1-20 objects {"label": string, "markdown": string}; labels must be unique, nonempty and at most 200 UTF-8 bytes, markdown nonempty and at most 8000 UTF-8 bytes per draft, and the entire input at most 200000 bytes. Do not mix - with paths.\n` +
      `--job-id requires an exact parsed identity in each non-test source path’s last commit. Unknown or unmatched evidence does not rule out earlier commits; a match does not establish semantic correctness. Cannot combine with --batch.\n` +
      `--batch takes 1-${JOB_PRECHECK_BATCH_MAX} draft paths and reports each in input order over a shared fact cache, so a path several drafts name is probed once. A draft that cannot be read or whose git probe fails is reported as an error for that draft and the batch continues; errors are never called fresh. Collisions list paths shared by successful drafts and their filenames as evidence only; JSON includes a collisions array. Collisions do not change the exit status. After the per-draft reports a count line tallies fresh, partly-on-master, likely-done and errors. Batch exits 2 when any draft errored, else 3 when any draft is likely-done, else 0. Read-only: never deletes files, launches jobs or writes queue state.`);
    return 0;
  }
  let ref = 'origin/master';
  let json = false;
  let batch = false;
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
  if (batch) {
    if (jobId !== undefined || (files.includes('-') && files.length !== 1)) { error(usage); return 2; }
    if (files.length === 0 || files.length > JOB_PRECHECK_BATCH_MAX) { error(usage); return 2; }

  }
  const file = files[0];
  if (!file) { error(usage); return 2; }
  let batchDrafts: Map<string, string> | undefined;
  if (batch && file === '-') {
    try {
      batchDrafts = await readBatchStdin((deps.readStdin ?? (() => process.stdin))());
    } catch {
      error('error: invalid or unreadable batch stdin');
      return 2;
    }
  }
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
  if (batch) {
    const batchDeps = batchDrafts ? { ...deps, readFile: async (label: string) => batchDrafts!.get(label)! } : deps;
    return runPrecheckBatch(batchDrafts ? [...batchDrafts.keys()] : files, ref, json, resolvedRef, git, batchDeps, log);
  }
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
