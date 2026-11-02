/**
 * core/fleet/main-health-read.ts — the main guardian's status on disk, shaped
 * for `GET /api/verse/runs-history/main-health` and the operator glance.
 *
 * The guardian (launchd ai.ashlr.main-guardian) writes
 * `supervisor/status-main-guardian.md` under the runs dir: a short markdown
 * note with one line per watched repo. The exact line shape is not
 * contract-frozen, so the parser is tolerant — `key=value`/`key: value`
 * fields, `name@branch` tokens, markdown table rows and bare `name … state`
 * lines all feed the same MainHealthRepo. A line that names a repo but gives
 * no readable state still lands in `repos` — as 'unknown', never 'green'.
 * Lines that are prose or headings are skipped, so a corrupt file cannot
 * invent healthy repos.
 *
 * `queue/MAIN_GUARDIAN_OFF` is the kill switch: its mere presence (lstat)
 * means the guardian is switched off. Staleness is the status file absent
 * while the runs dir exists, or a file mtime older than three times the
 * guardian's interval — taken from an `interval:`/`every N <unit>` line in
 * the file when it states one, else 30 minutes. A machine with no runs dir
 * reports source 'unavailable' and stale false — no fleet, no nagging.
 *
 * Read-only and bounded: O_NOFOLLOW, regular files only, 64 KiB cap, and the
 * whole text passes through scrubSecrets before parsing. Per-repo free-text
 * fields are clipped and nulled when they carry a home path; fix job ids are
 * kept only in the RQ-… shape.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';

export interface MainHealthRepo {
  repo: string; branch: string; sha: string | null;
  state: 'green' | 'red' | 'unknown';
  checkedAt: string | null; failingCheck: string | null;
  fixJobs: string[]; nightlyRed: string | null;
}

/** Exactly the wire shape src/web-ui/routes/verse/shell/main-health-query.ts validates. */
export interface MainHealthData {
  v: 1; generatedAt: string; source: 'ok' | 'unavailable';
  statusAt: string | null; stale: boolean; guardianOff: boolean;
  red: number; repos: MainHealthRepo[];
}

const STATUS_NAME = 'status-main-guardian.md';
const MAX_BYTES = 64 * 1024;
const MAX_REPOS = 64;
const MAX_LINES = 400;
const DEFAULT_INTERVAL_MS = 30 * 60_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 24 * 3_600_000;

const FIX_JOB = /^RQ-[A-Z0-9-]{3,60}$/;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,79})?$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const ISOISH = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const HOME_PATH = /(?:^|[\s"'`(=])~\/|\/Users\/|\/home\/|[A-Za-z]:\\Users\\/i;
const KV = /([A-Za-z][A-Za-z0-9_.-]{0,29})\s*[=:]\s*("[^"]*"|'[^']*'|`[^`]*`|[^\s,;|]+)/g;
const KV_TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,29}\s*[=:]/;

const STATE_WORDS: Record<string, MainHealthRepo['state']> = {
  green: 'green', ok: 'green', pass: 'green', passed: 'green', passing: 'green',
  healthy: 'green', up: 'green', good: 'green', clean: 'green', success: 'green', successful: 'green',
  red: 'red', fail: 'red', failed: 'red', failing: 'red', down: 'red',
  broken: 'red', failure: 'red', error: 'red', errored: 'red',
  unknown: 'unknown', stale: 'unknown', pending: 'unknown', skipped: 'unknown',
  unclear: 'unknown', none: 'unknown', na: 'unknown',
};

const norm = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

type FieldSlot = 'repo' | 'branch' | 'sha' | 'state' | 'checkedAt' | 'failingCheck' | 'fixJobs' | 'nightlyRed';

/** Lowercased/separator-stripped key → repo field. */
const FIELD_KEYS: Record<string, FieldSlot> = {
  repo: 'repo', repository: 'repo', name: 'repo', project: 'repo',
  branch: 'branch', ref: 'branch', track: 'branch',
  sha: 'sha', commit: 'sha', rev: 'sha', head: 'sha',
  state: 'state', status: 'state', health: 'state', result: 'state', ci: 'state', verdict: 'state',
  checked: 'checkedAt', checkedat: 'checkedAt', lastcheck: 'checkedAt', lastseen: 'checkedAt',
  seen: 'checkedAt', at: 'checkedAt', time: 'checkedAt', ts: 'checkedAt', timestamp: 'checkedAt',
  updated: 'checkedAt', generated: 'checkedAt', when: 'checkedAt',
  failing: 'failingCheck', failingcheck: 'failingCheck', failedcheck: 'failingCheck',
  check: 'failingCheck', failed: 'failingCheck', failure: 'failingCheck', failingstep: 'failingCheck',
  fix: 'fixJobs', fixjob: 'fixJobs', fixjobs: 'fixJobs', fixid: 'fixJobs', job: 'fixJobs', jobs: 'fixJobs',
  nightly: 'nightlyRed', nightlyred: 'nightlyRed', nightlycheck: 'nightlyRed',
};

/** Key words that carry file-level facts, never a repo name. */
const RESERVED = new Set([
  ...Object.keys(FIELD_KEYS), ...Object.keys(STATE_WORDS),
  'main', 'overall', 'summary', 'interval', 'intervalms', 'intervalsec', 'intervalsecs',
  'intervalseconds', 'intervalmin', 'intervalmins', 'intervalminutes', 'period', 'periods',
  'cadence', 'every', 'frequency', 'guardian', 'off', 'on', 'note', 'notes', 'next',
  'last', 'date', 'version', 'v', 'source', 'run', 'runs', 'log', 'dir', 'file',
  'wrote', 'written', 'detail', 'details', 'errors', 'warning', 'warnings', 'count',
  'total', 'generatedat', 'updatedat', 'statusat', 'the', 'a', 'an', 'is', 'are', 'was',
]);

const EMPTY_MARKERS = new Set(['-', '–', '—', 'none', 'n/a', 'na', 'null', '-none-']);

interface RepoFields {
  repo?: string; branch?: string; sha?: string; state?: string;
  checkedAt?: string; failingCheck?: string; nightlyRed?: string;
  fixJobs: string[]; kv: number; table: boolean;
}

/** O_NOFOLLOW, regular file, 64 KiB cap — readFileBounded's posture in operator-glance-read.ts. */
async function readStatusText(path: string): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    return scrubSecrets(bytes.subarray(0, offset).toString('utf8'));
  } finally {
    await file.close();
  }
}

function cleanFreeText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = scrubSecrets(value).replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!text || HOME_PATH.test(text)) return null;
  const home = homedir();
  if (home.length > 3 && text.includes(home)) return null;
  return text;
}

function toRepo(fields: RepoFields): MainHealthRepo | null {
  const repo = (fields.repo ?? '').trim().replace(/^`+|`+$/g, '');
  if (!REPO_NAME.test(repo) || RESERVED.has(norm(repo))) return null;
  const branch = fields.branch && BRANCH_NAME.test(fields.branch) && !RESERVED.has(norm(fields.branch))
    ? fields.branch : 'main';
  const sha = fields.sha && SHA.test(fields.sha) ? fields.sha : null;
  const rawAt = fields.checkedAt;
  const checkedAt = rawAt && ISOISH.test(rawAt) && Number.isFinite(Date.parse(rawAt))
    ? new Date(Date.parse(rawAt)).toISOString() : null;
  return {
    repo, branch, sha,
    state: STATE_WORDS[norm(fields.state ?? '')] ?? 'unknown',
    checkedAt,
    failingCheck: cleanFreeText(fields.failingCheck),
    fixJobs: [...new Set(fields.fixJobs.filter((job) => FIX_JOB.test(job)))],
    nightlyRed: cleanFreeText(fields.nightlyRed),
  };
}

/** `key=value` / `key: value` pairs on a chunk, mapped through FIELD_KEYS. */
function absorbKv(chunk: string, fields: RepoFields): void {
  for (const match of chunk.matchAll(KV)) {
    const key = norm(match[1]!);
    const value = (match[2] ?? '').replace(/^["'`]|["'`]$/g, '').trim();
    if (!value || EMPTY_MARKERS.has(value.toLowerCase())) continue;
    fields.kv += 1;
    const slot = FIELD_KEYS[key];
    if (slot === 'fixJobs') {
      for (const part of value.split(/[\s,]+/)) if (FIX_JOB.test(part)) fields.fixJobs.push(part);
    } else if (slot !== undefined) {
      if (fields[slot] === undefined) fields[slot] = value;
    } else if (!RESERVED.has(key) && REPO_NAME.test(match[1]!) && STATE_WORDS[norm(value)] !== undefined) {
      // `phantom: green` — an unknown key carrying a state word names the repo.
      if (fields.repo === undefined) fields.repo = match[1]!;
      if (fields.state === undefined) fields.state = value;
    }
  }
}

type Line = { kind: 'header'; cells: Array<FieldSlot | ''> } | { kind: 'row'; fields: RepoFields } | null;

/**
 * One line → one repo row, a table header, or null when the line is prose.
 * A repo claim needs corroboration — a bare `the fleet is green` cannot pass:
 * at least two signals (a kv pair, a state word, a sha, a timestamp, an
 * @branch suffix, a fix-job id, or being a table row) must be present before
 * the first token is taken as a repo name — unless the row sits under a
 * table header the file already declared (`headerSeen`).
 */
function parseRepoLine(raw: string, headerSeen: boolean): Line {
  let line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith('<!--') || /^[-=~_]{3,}$/.test(line)) return null;
  line = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX-]\]\s*/, '').trim();
  if (!line) return null;
  const isTable = line.includes('|');
  const chunks = isTable
    ? line.split('|').map((cell) => cell.trim()).filter((cell) => cell !== '')
    : [line];
  if (isTable && chunks.length >= 2
    && chunks.every((cell) => /^[A-Za-z][A-Za-z _-]{0,30}$/.test(cell))
    && chunks.filter((cell) => FIELD_KEYS[norm(cell)] !== undefined).length >= 2) {
    return { kind: 'header', cells: chunks.map((cell) => FIELD_KEYS[norm(cell)] ?? '') as Array<FieldSlot | ''> };
  }
  const fields: RepoFields = { fixJobs: [], kv: 0, table: isTable };
  for (const chunk of chunks) absorbKv(chunk, fields);
  const positional = chunks.flatMap((chunk) => chunk.split(/\s+/))
    .map((token) => token.replace(/^["'`(]+|["'`),;.:\]]+$/g, ''))
    .filter(Boolean);
  let atBranch = false;
  let nameChecked = false;
  const leftover: string[] = [];
  for (const token of positional) {
    if (KV_TOKEN.test(token) || token.includes('=')) continue; // kv pairs already consumed
    const lower = norm(token);
    if (!nameChecked) {
      nameChecked = true;
      let candidate = token;
      const at = candidate.lastIndexOf('@');
      if (at > 0 && at < candidate.length - 1) {
        const branch = candidate.slice(at + 1);
        if (BRANCH_NAME.test(branch) && fields.branch === undefined) {
          fields.branch = branch;
          atBranch = true;
        }
        candidate = candidate.slice(0, at);
      }
      // A leading reserved or non-repo word means a fact line (`status: ok`), not a repo.
      if (RESERVED.has(norm(candidate)) || !REPO_NAME.test(candidate) || STATE_WORDS[norm(candidate)] !== undefined) return null;
      if (fields.repo === undefined) fields.repo = candidate;
      continue;
    }
    if (EMPTY_MARKERS.has(token.toLowerCase()) || EMPTY_MARKERS.has(lower)) continue;
    if (SHA.test(token)) { if (fields.sha === undefined) fields.sha = token; continue; }
    if (ISOISH.test(token) && Number.isFinite(Date.parse(token))) {
      if (fields.checkedAt === undefined) fields.checkedAt = token;
      continue;
    }
    if (FIX_JOB.test(token)) { fields.fixJobs.push(token); continue; }
    if (STATE_WORDS[lower] !== undefined) { if (fields.state === undefined) fields.state = token; continue; }
    leftover.push(token);
  }
  for (const text of leftover) {
    const word = norm(text);
    // Common mainline names are branch-eligible even though `main` is a
    // reserved fact-line word: `- phantom main red` must not eat it.
    const mainline = word === 'main' || word === 'master' || word === 'trunk' || word === 'develop';
    if (fields.branch === undefined && BRANCH_NAME.test(text) && (!RESERVED.has(word) || mainline)) {
      fields.branch = text;
    } else {
      fields.failingCheck = fields.failingCheck === undefined ? text : `${fields.failingCheck} ${text}`;
    }
  }
  if (fields.repo === undefined) return null;
  const signals = (fields.kv > 0 ? 1 : 0) + (fields.state !== undefined ? 1 : 0)
    + (fields.sha !== undefined ? 1 : 0) + (fields.checkedAt !== undefined ? 1 : 0)
    + (fields.fixJobs.length > 0 ? 1 : 0) + (fields.table ? 1 : 0) + (atBranch ? 1 : 0);
  if (signals < 2 && !(headerSeen && isTable)) return null;
  return { kind: 'row', fields };
}

/** `interval: 5m`, `interval_seconds: 300`, `every 30 minutes` — the guardian's cadence. */
function parseIntervalMs(text: string): number | null {
  const units: Record<string, number> = {
    ms: 1, millisecond: 1, milliseconds: 1, s: 1000, sec: 1000, secs: 1000,
    second: 1000, seconds: 1000, m: 60_000, min: 60_000, mins: 60_000,
    minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000,
    hour: 3_600_000, hours: 3_600_000,
  };
  const clamp = (ms: number): number | null => ms >= MIN_INTERVAL_MS && ms <= MAX_INTERVAL_MS ? ms : null;
  const kv = /\b(interval[_-]?(?:ms|s|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hrs|hour|hours)?|period[_-]?(?:seconds?|minutes?|hours?)?|cadence|frequency|every)\s*[=:]\s*(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?\b/i.exec(text);
  if (kv) {
    const key = norm(kv[1]!);
    const n = Number(kv[2]!);
    const suffix = (kv[3] ?? '').toLowerCase();
    let ms: number | null = null;
    if (suffix && units[suffix] !== undefined) ms = n * units[suffix]!;
    else if (key.endsWith('ms')) ms = n;
    else if (/(?:seconds?|secs?|s)$/.test(key)) ms = n * 1000;
    else if (/(?:minutes?|mins?|m)$/.test(key)) ms = n * 60_000;
    else if (/(?:hours?|hrs?|h)$/.test(key)) ms = n * 3_600_000;
    else ms = n < 60 ? n * 60_000 : n * 1000; // bare `interval: 300` reads as seconds; `interval: 5` as minutes
    const bounded = clamp(ms);
    if (bounded !== null) return bounded;
  }
  const phrase = /\bevery\s+(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i.exec(text);
  if (phrase) {
    const bounded = clamp(Number(phrase[1]) * units[phrase[2]!.toLowerCase()]!);
    if (bounded !== null) return bounded;
  }
  return null;
}

/** The parsed status file: repo rows plus the cadence line, if one was written. */
export function parseMainHealthStatus(text: string): { repos: MainHealthRepo[]; intervalMs: number | null } {
  const repos: MainHealthRepo[] = [];
  const seen = new Set<string>();
  let columns: Array<FieldSlot | ''> | null = null;
  for (const raw of text.split(/\r?\n/).slice(0, MAX_LINES)) {
    const line = parseRepoLine(raw, columns !== null);
    if (line === null) continue;
    if (line.kind === 'header') { columns = line.cells; continue; }
    const { fields } = line;
    if (columns !== null && fields.table) {
      // Table row under a known header: cells map by column, and the
      // positional pass's guesses do not mix in.
      const slots = columns;
      const mapped: RepoFields = { fixJobs: [], kv: fields.kv, table: true };
      raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').split('|').map((cell) => cell.trim()).filter((cell) => cell !== '')
        .forEach((cell, index) => {
          const slot = slots[index];
          if (!slot || EMPTY_MARKERS.has(cell.toLowerCase())) return;
          if (slot === 'fixJobs') {
            for (const part of cell.split(/[\s,]+/)) if (FIX_JOB.test(part)) mapped.fixJobs.push(part);
          } else {
            mapped[slot] = cell;
          }
        });
      const repo = toRepo(mapped);
      if (repo === null) continue;
      const key = `${repo.repo}@${repo.branch}`;
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push(repo);
      if (repos.length >= MAX_REPOS) break;
      continue;
    }
    const repo = toRepo(fields);
    if (repo === null) continue;
    const key = `${repo.repo}@${repo.branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push(repo);
    if (repos.length >= MAX_REPOS) break;
  }
  return { repos, intervalMs: parseIntervalMs(text) };
}

/**
 * The guardian's status under `runsDir` (`$ASHLR_RUNS_DIR`, else
 * `~/.ashlr-runs`). Never throws for absent/unreadable files — missing data
 * is a status, not an exception.
 */
export async function readMainHealth(opts: { runsDir?: string; now?: () => number } = {}): Promise<MainHealthData> {
  const now = opts.now ?? Date.now;
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let guardianOff = false;
  try { guardianOff = (await lstat(join(runsDir, 'queue', 'MAIN_GUARDIAN_OFF'))) !== null; }
  catch { /* absent kill switch */ }
  const base: MainHealthData = {
    v: 1, generatedAt: new Date(now()).toISOString(), source: 'unavailable',
    statusAt: null, stale: false, guardianOff, red: 0, repos: [],
  };
  const dir = await lstat(runsDir).catch(() => null);
  if (!dir?.isDirectory()) return base;
  const info = await lstat(join(runsDir, 'supervisor', STATUS_NAME)).catch(() => null);
  if (!info?.isFile()) return { ...base, source: 'ok', stale: true };
  const statusAt = new Date(info.mtimeMs).toISOString();
  const text = await readStatusText(join(runsDir, 'supervisor', STATUS_NAME));
  if (text === null) {
    // Known file we could not read: report it, never fake freshness.
    return { ...base, source: 'unavailable', statusAt, stale: true };
  }
  const { repos, intervalMs } = parseMainHealthStatus(text);
  return {
    ...base, source: 'ok', statusAt,
    stale: now() - info.mtimeMs > 3 * (intervalMs ?? DEFAULT_INTERVAL_MS),
    red: repos.reduce((total, repo) => total + (repo.state === 'red' ? 1 : 0), 0),
    repos,
  };
}
