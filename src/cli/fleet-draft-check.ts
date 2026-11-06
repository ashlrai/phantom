/** Read-only: is an in-memory batch of draft jobs already on origin/master? */
import { parseJobHeader } from '../core/fleet/job-header.js';
import {
  JOB_PRECHECK_BATCH_MAX,
  precheckJobBatch,
  type JobPrecheckBatchCounts,
  type JobPrecheckCollision,
  type JobPrecheckReport,
} from '../core/fleet/job-precheck-batch.js';
import { extractJobPaths, type JobPrecheckGit, type PrecheckFact } from '../core/fleet/job-precheck.js';
import {
  queuedCollisions,
  readQueuedPathClaims,
  type QueuedCollision,
  type QueuedPathClaims,
} from '../core/fleet/queued-path-claims.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { gitJobProbe, resolveJobPrecheckRef } from './fleet-job-precheck.js';

const usage = 'Usage: ashlr fleet draft-check --stdin [--json] [--queued] [--fail-on-collision]';
const REF = 'origin/master';
const STDIN_MAX_BYTES = 180_000;
const MARKDOWN_MAX_BYTES = 8_000;
const DRAFT_NAME = /^RQ-PHX-[A-Z0-9]{3,40}\.md$/;
const RESOLVED_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface DraftCheckCliDeps {
  git?: JobPrecheckGit;
  resolveRef?: (ref: string) => Promise<string>;
  readStdin?: () => AsyncIterable<Uint8Array>;
  readQueuedClaims?: () => Promise<QueuedPathClaims>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

interface Draft {
  name: string;
  markdown: string;
}

async function readInput(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > STDIN_MAX_BYTES) throw new Error(`stdin exceeds ${STDIN_MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Line 1 is everything before the first LF; the CR of a CRLF terminator is
 * consumed by the ending, not the line — the same split job-precheck.ts and
 * the re-issue path (`\r?\n`) apply. A lone CR stays in the line and fails the
 * anchored header parse. Nothing else is trimmed: a leading blank line or
 * space can never be normalized into acceptance.
 */
function firstLine(markdown: string): string {
  return markdown.split(/\r?\n/, 1)[0] ?? '';
}

/** Strict shape check: every violation throws before any git probe runs. */
function parseDrafts(input: string): Draft[] {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error('stdin is not one JSON object {"drafts":[{"name","markdown"}]}');
  }
  if (!isObject(value) || Object.keys(value).join(',') !== 'drafts') {
    throw new Error('stdin must be one JSON object with a "drafts" field and no other fields');
  }
  const list = value.drafts;
  if (!Array.isArray(list) || list.length < 1 || list.length > JOB_PRECHECK_BATCH_MAX) {
    throw new Error(`drafts must be an array of 1-${JOB_PRECHECK_BATCH_MAX} entries`);
  }
  const seen = new Set<string>();
  return list.map((entry, i) => {
    const where = `drafts[${i}]`;
    if (!isObject(entry) || Object.keys(entry).sort().join(',') !== 'markdown,name') {
      throw new Error(`${where} must have exactly the "name" and "markdown" fields`);
    }
    const { name, markdown } = entry;
    if (typeof name !== 'string' || !DRAFT_NAME.test(name)) {
      throw new Error(`${where}.name must match RQ-PHX-[A-Z0-9]{3,40}.md`);
    }
    if (seen.has(name)) throw new Error(`duplicate draft name ${name}`);
    seen.add(name);
    if (typeof markdown !== 'string' || !markdown.trim()) {
      throw new Error(`${where}.markdown must be nonempty UTF-8`);
    }
    if (Buffer.byteLength(markdown, 'utf8') > MARKDOWN_MAX_BYTES) {
      throw new Error(`${where}.markdown exceeds ${MARKDOWN_MAX_BYTES} bytes`);
    }
    const header = parseJobHeader(firstLine(markdown), name);
    if (!header.ok) throw new Error(`draft ${name}: ${header.error}`);
    if (header.repo !== 'phantom') {
      throw new Error(`draft ${name}: repo must be phantom (got "${header.repo.slice(0, 40)}")`);
    }
    return { name, markdown };
  });
}

function factLine(fact: PrecheckFact): string {
  const state = fact.onMaster ? 'on-master' : 'missing';
  if (!fact.lastCommit) return `${fact.path} ${state}`;
  return `${fact.path} ${state} ${fact.lastCommit.sha} ${fact.lastCommit.subject.replace(/[\r\n]+/g, ' ')}`;
}

/** In-memory batch precheck: validates input, pins origin/master once, then probes per draft. */
export async function cmdFleetDraftCheck(args: string[], deps: DraftCheckCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  if (args.includes('--help') || args.includes('-h')) {
    log(`${usage}\n` +
      `Reads one JSON object on stdin: {"drafts":[{"name":"RQ-PHX-ID.md","markdown":"..."}]} with 1-${JOB_PRECHECK_BATCH_MAX} drafts.\n` +
      `Each name must be a unique RQ-PHX-[A-Z0-9]{3,40}.md basename; each markdown must be nonempty UTF-8 of at most ${MARKDOWN_MAX_BYTES} bytes.\n` +
      `Each markdown's first line must be the dispatch header \`#job repo=phantom lane=<lane> tier=<tier>\` — single spaces, lowercase fields, repo literally phantom, tier one of fast, mid, work, frontier. A CRLF ending is accepted; a leading blank line or space is never trimmed into acceptance.\n` +
      `The whole input is limited to ${STDIN_MAX_BYTES} bytes. Unknown fields, duplicate names and malformed input are rejected before any git probe.\n` +
      `There are no file, ref, cwd or executable arguments: the batch is always checked against origin/master, resolved once to an immutable commit.\n` +
      `Each draft's named src, test, docs, schema and scripts paths are probed over a shared fact cache, so a path several drafts name is probed once; paths named by two or more drafts are reported as collisions.\n` +
      `--queued also reads only the queue prompts directory (<runs>/queue/prompts under ASHLR_RUNS_DIR, default ~/.ashlr-runs) and reports queued-collision lines when a draft names a path a still-waiting RQ-PHX job names; the queue source prints as queued: healthy|missing|degraded. A queued prompt with the draft's own id is a re-issue, not a collision. Advisory only: it never changes the exit code.\n` +
      `--fail-on-collision is a planner check only: it exits 4 when successful drafts share an implementation path (test/spec paths never count), letting a planner stop an overlapping pipeline before submitting. Reports, schemas and text output are unchanged; no queue writes and no authorization effect.\n` +
      `Read-only: never writes files, deletes, launches jobs or mutates queue state.\n` +
      `Exits 2 on malformed input, an unresolvable ref or any per-draft error; else 3 when any draft is likely-done; else 4 when --fail-on-collision is set and collisions are present; else 0.`);
    return 0;
  }
  let json = false;
  let stdin = false;
  let queued = false;
  let failOnCollision = false;
  for (const arg of args) {
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--stdin' && !stdin) { stdin = true; continue; }
    if (arg === '--queued' && !queued) { queued = true; continue; }
    if (arg === '--fail-on-collision' && !failOnCollision) { failOnCollision = true; continue; }
    error(usage);
    return 2;
  }
  if (!stdin) { error(usage); return 2; }
  let drafts: Draft[];
  try {
    const raw = await readInput((deps.readStdin ?? (() => process.stdin))());
    drafts = parseDrafts(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : 'invalid input';
    error(`error: ${message.slice(0, 300)}`);
    return 2;
  }
  let resolvedRef: string;
  try {
    resolvedRef = await (deps.resolveRef ?? resolveJobPrecheckRef)(REF);
    if (!RESOLVED_COMMIT.test(resolvedRef)) throw new Error('invalid resolved commit');
  } catch {
    error(`error: cannot resolve ref ${REF} to a commit`);
    return 2;
  }
  const byName = new Map(drafts.map(draft => [draft.name, draft.markdown]));
  const result = await precheckJobBatch(drafts.map(draft => draft.name), {
    readFile: async (name) => {
      const markdown = byName.get(name);
      if (markdown === undefined) throw new Error(`cannot read ${name}`);
      return markdown;
    },
    git: deps.git ?? gitJobProbe(resolvedRef),
  });
  const results = result.entries.map((entry) =>
    entry.report ? { file: entry.file, ...entry.report } : { file: entry.file, error: entry.error });
  // Advisory: the queued-claims read can never make the batch check fail.
  let queuedSource: QueuedPathClaims['sourceState'] | undefined;
  let queuedHits: QueuedCollision[] = [];
  if (queued) {
    try {
      const read = await (deps.readQueuedClaims ?? readQueuedPathClaims)();
      queuedSource = read.sourceState;
      queuedHits = queuedCollisions(
        drafts.map(draft => ({ name: draft.name, paths: extractJobPaths(draft.markdown) })),
        read.claims,
      );
    } catch {
      queuedSource = 'degraded';
      queuedHits = [];
    }
  }
  const safe = sanitizePublicJson({
    schema: 'fleet.draft-check.v1', ref: REF, resolvedRef,
    results, counts: result.counts, collisions: result.collisions,
    ...(queued ? { queuedCollisions: queuedHits, queuedSource } : {}),
  }) as {
    results: Array<{ file: string; error?: string } & Partial<JobPrecheckReport>>;
    counts: JobPrecheckBatchCounts;
    collisions: JobPrecheckCollision[];
    queuedCollisions?: QueuedCollision[];
    queuedSource?: QueuedPathClaims['sourceState'];
  };
  if (json) log(JSON.stringify(safe));
  else {
    log(`snapshot: ${REF} -> ${resolvedRef}`);
    for (const entry of safe.results) {
      log(`== ${entry.file}`);
      if (entry.error !== undefined) log(`error: ${entry.error}`);
      else {
        for (const fact of entry.facts ?? []) log(factLine(fact));
        log(`verdict: ${entry.verdict}`);
      }
    }
    for (const collision of safe.collisions) log(`collision: ${collision.path} <- ${collision.files.join(', ')}`);
    for (const hit of safe.queuedCollisions ?? []) log(`queued-collision: ${hit.path} <- ${hit.draft} vs ${hit.queued.join(', ')}`);
    const counts = safe.counts;
    log(`batch: fresh=${counts.fresh} partly-on-master=${counts['partly-on-master']} ` +
      `likely-done=${counts['likely-done']} errors=${counts.errors}`);
    if (queued) log(`queued: ${safe.queuedSource}`);
  }
  if (safe.counts.errors > 0) return 2;
  if (safe.counts['likely-done'] > 0) return 3;
  return failOnCollision && safe.collisions.length > 0 ? 4 : 0;
}
