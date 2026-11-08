/** Read-only, bounded projection of dispatchd's queue and precheck log. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { parseReadyTsv } from './lane-console.js';
import { scrubSecrets } from '../util/scrub.js';

export const VERSE_FLEET_LIVE_QUEUE_PATH = '/api/verse/fleet/live/queue';
/** PARKED-DEP / PARKED-DEPENDENCY row whose DEPENDENCY GATE ids are not all MERGED. */
export interface ParkedUnmetDep { job: string; lane: string | null; unmet: string[] }
/** PARKED-DEP / PARKED-DEPENDENCY row whose DEPENDENCY GATE ids all show MERGED — the auto-unpark pass should have freed it already. */
export interface ParkedMetDep { job: string; lane: string | null; gates: string[] }
export interface ParkedGroup { reason: string; lane: string | null; count: number; jobs: string[] }
export interface PrecheckSkip { at: string; job: string; code: string; reason: string }
export type Source = 'healthy' | 'missing' | 'degraded';
export interface FleetQueueV1 {
  v: 1; generatedAt: string;
  sources: Record<'ready' | 'skips', Source>;
  total: number; ready: number; parked: number; malformed: number;
  byLane: Array<{ lane: string; ready: number; parked: number; phantom?: number; other?: number; otherRepos?: string[] }>;
  nextUp?: Array<{ lane: string; jobs: string[] }>;
  groups: ParkedGroup[];
  /** Parked dependency rows still waiting on MERGED outcomes (RQ-QUEUE-AUTOUNPARK-1). */
  unmetDeps?: ParkedUnmetDep[];
  /** Opt-in via `depDetail`: parked dependency rows whose gate ids are all MERGED but were never unparked — a stale-park signal. */
  metDeps?: ParkedMetDep[];
  skips: PrecheckSkip[];
  skipsLast24h: number | null;
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PARKED = /^PARKED-([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9][A-Za-z0-9._@-]{0,63}))?$/i;
const DEP_REASON = /^(?:DEP|DEPENDENCY)$/i;
const GATE_LINE = /DEPENDENCY\s+GATE[:\s]+([^\n]+)/i;
const GATE_TOK = /\b([A-Za-z0-9][A-Za-z0-9._-]{0,79})\b/g;
const GATE_SKIP = new Set(['DEPENDENCY', 'GATE', 'AND', 'OR', 'NONE', 'N/A']);
const MAX_READY = 2 * 1024 * 1024;
const MAX_SKIPS = 256 * 1024;
const MAX_PROMPT = 64 * 1024;
const MAX_JOBS_JSONL = 2 * 1024 * 1024;
// eslint-disable-next-line no-control-regex -- public fields must not carry control bytes.
const UNSAFE_PUBLIC_FIELD = /[/\\\x00-\x1f\x7f]/;

/** Parse DEPENDENCY GATE ids from a restock/dispatch prompt body. */
export function parseDependencyGateIds(text: string): string[] {
  const match = GATE_LINE.exec(text);
  if (!match?.[1]) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of match[1].match(GATE_TOK) ?? []) {
    if (GATE_SKIP.has(tok.toUpperCase()) || seen.has(tok) || !JOB_ID.test(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/** MERGED job ids from a bounded jobs.jsonl metrics ledger. */
export function mergedJobsFromJsonl(text: string): Set<string> {
  const merged = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { event?: unknown; state?: unknown; job?: unknown };
      if (row.event === 'outcome' && row.state === 'MERGED' && typeof row.job === 'string' && JOB_ID.test(row.job)) {
        merged.add(row.job);
      }
    } catch { /* skip malformed ledger lines */ }
  }
  return merged;
}

/** Matches the console's queue classification without importing UI code. */
export function isPhantomJob(item: { lane: string; id?: string | null; repo?: string | null }): boolean {
  return /^(?:[^/]+\/)?phantom$/i.test(item.repo?.trim() ?? '')
    || (item.id?.startsWith('RQ-PHX-') ?? false);
}

export function parseParkedState(state: string): { parked: boolean; reason: string | null; lane: string | null } {
  const match = PARKED.exec(state);
  return match ? { parked: true, reason: match[1]!.toUpperCase(), lane: match[2] ?? null }
    : { parked: false, reason: null, lane: null };
}

function boundedLimit(limit?: number): number {
  return Number.isNaN(limit) ? 25 : Math.min(200, Math.max(1, Math.floor(limit ?? 25)));
}

/** Render a valid local Date as ISO text carrying the actual local offset. */
export function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** Parse local wall time and render its actual offset, including DST. */
export function localTimestamp(raw: string): { at: string; ms: number } {
  const match = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(raw);
  if (match) {
    const [, y, m, d, h, min, s] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s));
    if (date.getFullYear() === Number(y) && date.getMonth() === Number(m) - 1 && date.getDate() === Number(d) &&
        date.getHours() === Number(h) && date.getMinutes() === Number(min) && date.getSeconds() === Number(s)) {
      return { at: localIso(date), ms: date.getTime() };
    }
  }
  return { at: raw, ms: Number.NaN };
}

function parseSkips(text: string, nowMs: number, limit?: number): { skips: PrecheckSkip[]; last24h: number; dropped: number } {
  const rows: Array<{ value: PrecheckSkip; ms: number; order: number }> = [];
  let dropped = 0;
  let last24h = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.replace(/\r$/, '').split('\t');
    const [at, job, code, reason] = cells;
    // No paths or control characters may escape through any public field.
    if (cells.length !== 4 || !at || !job || !JOB_ID.test(job) || !code || !reason ||
        [at, code, reason].some((cell) => cell.length > 400 || UNSAFE_PUBLIC_FIELD.test(cell))) {
      dropped++;
      continue;
    }
    const timestamp = localTimestamp(at);
    if (timestamp.ms <= nowMs && timestamp.ms >= nowMs - 24 * 60 * 60 * 1000) last24h++;
    rows.push({ value: { at: scrubSecrets(timestamp.at), job, code: scrubSecrets(code), reason: scrubSecrets(reason) }, ms: timestamp.ms, order: rows.length });
  }
  rows.sort((a, b) => (Number.isFinite(b.ms) ? b.ms : -Infinity) - (Number.isFinite(a.ms) ? a.ms : -Infinity) || b.order - a.order);
  return { skips: rows.slice(0, boundedLimit(limit)).map((row) => row.value), last24h, dropped };
}

export function parsePrecheckSkips(text: string, nowMs: number, limit?: number): { skips: PrecheckSkip[]; last24h: number } {
  const { skips, last24h } = parseSkips(text, nowMs, limit);
  return { skips, last24h };
}

export async function readSource(path: string, max: number, tail: boolean): Promise<{ state: Source; text: string }> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile()) throw new Error('invalid source');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || (!tail && info.size > max)) throw new Error('invalid source');
    const start = tail ? Math.max(0, info.size - max) : 0;
    const buffer = Buffer.alloc(Math.min(info.size, max));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, start + length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    let text = buffer.subarray(0, length).toString('utf8');
    if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return { state: 'healthy', text };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded', text: '' };
  } finally { await file?.close().catch(() => undefined); }
}

export async function readFleetQueue(opts: { runsDir?: string; now?: () => number; limit?: number; depDetail?: boolean; onWaitingJob?: (lane: string, id: string) => void } = {}): Promise<FleetQueueV1> {
  const now = (opts.now ?? Date.now)();
  const root = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const [readySource, skipsSource] = await Promise.all([
    readSource(join(root, 'queue', 'ready.tsv'), MAX_READY, false),
    readSource(join(root, 'queue', 'precheck-skips.tsv'), MAX_SKIPS, true),
  ]);
  // An upgraded queue can contain positional rows alongside headered rows.
  // Parse each row with the active header unless it has a positional status;
  // the shared parser otherwise applies that header to all subsequent rows.
  let header: string | null = null;
  let statusColumn = -1;
  let repoColumn = -1;
  const parsedRows: Array<{ row: ReturnType<typeof parseReadyTsv>['rows'][number]; originalState: string | undefined; unsafeRepo: boolean }> = [];
  let dropped = 0;
  /** Private prompt paths captured from raw cells — never emitted publicly. */
  const rawDepPromptByJob = new Map<string, string>();
  for (const raw of readySource.text.split('\n')) {
    if (parsedRows.length >= 50_000) break; // Match the shared parser's row bound.
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const cells = line.split('\t').map((cell) => cell.trim());
    while (cells.at(-1) === '') cells.pop();
    const names = cells.map((cell) => cell.toLowerCase().replace(/[^a-z]/g, ''));
    if (names.length >= 2 && names.every((name) => /^(?:id|job|jobid|task|name|status|state|pool|lane|account|repo|repository|project|tier|priority|pri|title|summary|at|ts|time|timestamp|updated|updatedat|createdat|landedat|mergedat|completedat)$/.test(name)) &&
        names.some((name) => /^(?:status|state|pool|lane|account)$/.test(name))) {
      header = line;
      repoColumn = names.findIndex((name) => /^(?:repo|repository|project)$/.test(name));
      statusColumn = names.findIndex((name) => name === 'status' || name === 'state');
      continue;
    }
    const first = cells[0] ?? '';
    const positional = !header || (statusColumn !== 0 && (/^READY$/i.test(first) || PARKED.test(first)));
    const input = positional && PARKED.test(first) ? `status=${first}\t${cells.slice(1).join('\t')}` : line;
    const result = parseReadyTsv(positional ? input : `${header}\n${input}`);
    dropped += result.dropped;
    const row = result.rows[0];
    if (!row) continue;
    const originalState = positional
      ? (PARKED.test(first) ? first : cells.find((cell) => /^(?:status|state)=/i.test(cell))?.replace(/^(?:status|state)=/i, ''))
      : cells[statusColumn];
    const rawCells = line.split('\t');
    const rawRepo = !positional && repoColumn >= 0 ? rawCells[repoColumn] : undefined;
    const unsafeRepo = rawRepo !== undefined ? UNSAFE_PUBLIC_FIELD.test(rawRepo)
      : rawCells.some((cell) => UNSAFE_PUBLIC_FIELD.test(cell));
    // Status-first PARKED-DEP: status \t job \t lane \t tier \t repo \t prompt
    // Dispatcher 5-col: job \t repo \t PARKED-DEP.lane \t tier \t prompt
    const depStatus = PARKED.exec(first);
    if (depStatus && DEP_REASON.test(depStatus[1]!) && cells[1] && JOB_ID.test(cells[1]) && cells[5]) {
      rawDepPromptByJob.set(cells[1], cells[5]!);
    } else if (cells[0] && JOB_ID.test(cells[0])) {
      const depLane = PARKED.exec(cells[2] ?? '');
      if (depLane && DEP_REASON.test(depLane[1]!) && cells[4]) rawDepPromptByJob.set(cells[0], cells[4]!);
    }
    parsedRows.push({ row, originalState, unsafeRepo });
  }
  const lanes = new Map<string, { lane: string; ready: number; parked: number; phantom: number; other: number; otherRepos: Set<string> }>();
  const nextUp = new Map<string, string[]>();
  const groups = new Map<string, ParkedGroup>();
  /** Private prompt paths for DEP rows — never emitted in the public projection. */
  const depPromptByJob = new Map<string, { lane: string | null; promptPath: string | null }>();
  let ready = 0;
  let parked = 0;
  let malformed = dropped;
  for (const { row, originalState, unsafeRepo } of parsedRows) {
    const statusText = originalState?.toUpperCase() === row.status ? originalState : row.status;
    const statusParked = parseParkedState(statusText);
    // Dispatcher 5-col parked rows keep status READY and put PARKED-REASON.lane in the pool column.
    const poolParked = parseParkedState(row.pool);
    const parkedState = statusParked.parked ? statusParked : poolParked;
    if (!row.id || !JOB_ID.test(row.id) || (!parkedState.parked && row.status !== 'READY')) { malformed++; continue; }
    const lane = (parkedState.parked ? parkedState.lane : null) ?? row.pool;
    opts.onWaitingJob?.(lane, row.id);
    const counts = lanes.get(lane) ?? { lane, ready: 0, parked: 0, phantom: 0, other: 0, otherRepos: new Set<string>() };
    lanes.set(lane, counts);
    if (!parkedState.parked) {
      ready++; counts.ready++;
      // readSource reads a bounded window of ready.tsv, so "first" means
      // first within the read window — file order is launch order.
      const jobs = nextUp.get(lane) ?? [];
      if (jobs.length < 3) { jobs.push(row.id); nextUp.set(lane, jobs); }
      if (isPhantomJob({ lane, id: row.id, repo: row.repo ?? null })) counts.phantom++;
      else {
        counts.other++;
        const repo = row.repo?.trim() || 'unknown';
        if (!unsafeRepo && !UNSAFE_PUBLIC_FIELD.test(repo)) counts.otherRepos.add(scrubSecrets(repo));
      }
      continue;
    }
    parked++; counts.parked++;
    const reason = parkedState.reason!;
    const key = `${reason}\0${lane}`;
    const group = groups.get(key) ?? { reason, lane, count: 0, jobs: [] };
    group.count++;
    group.jobs.push(row.id);
    groups.set(key, group);
    if (DEP_REASON.test(reason)) {
      depPromptByJob.set(row.id, { lane, promptPath: rawDepPromptByJob.get(row.id) ?? null });
    }
  }
  if (malformed) readySource.state = 'degraded';
  const skips = parseSkips(skipsSource.text, now, opts.limit);
  if (skips.dropped) skipsSource.state = 'degraded';
  const { unmetDeps, metDeps } = await readUnmetDeps(root, depPromptByJob, opts.depDetail === true);
  return {
    v: 1, generatedAt: new Date(now).toISOString(), sources: { ready: readySource.state, skips: skipsSource.state },
    total: ready + parked, ready, parked, malformed,
    byLane: [...lanes.values()].map((counts) => ({ ...counts, otherRepos: [...counts.otherRepos].sort().slice(0, 5) })).sort((a, b) => a.lane.localeCompare(b.lane)),
    nextUp: [...nextUp.entries()].map(([lane, jobs]) => ({ lane, jobs })).sort((a, b) => a.lane.localeCompare(b.lane)),
    groups: [...groups.values()].map((group) => ({ ...group, jobs: group.jobs.sort().slice(0, 8) }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason) || (a.lane ?? '').localeCompare(b.lane ?? '')),
    unmetDeps,
    ...(metDeps === undefined ? {} : { metDeps }),
    skips: skips.skips, skipsLast24h: skipsSource.state === 'degraded' && !skipsSource.text ? null : skips.last24h,
  };
}

async function readUnmetDeps(
  root: string,
  depPromptByJob: Map<string, { lane: string | null; promptPath: string | null }>,
  includeMet: boolean,
): Promise<{ unmetDeps: ParkedUnmetDep[]; metDeps?: ParkedMetDep[] }> {
  if (depPromptByJob.size === 0) return { unmetDeps: [], metDeps: includeMet ? [] : undefined };
  const mergedSource = await readSource(join(root, 'metrics', 'jobs.jsonl'), MAX_JOBS_JSONL, true);
  const merged = mergedJobsFromJsonl(mergedSource.text);
  const realRoot = await realpath(root).then(
    (real) => (real.endsWith(sep) ? real : real + sep),
    () => null,
  );
  const rows: ParkedUnmetDep[] = [];
  const met: ParkedMetDep[] = [];
  for (const [job, meta] of [...depPromptByJob.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let ids: string[] = [];
    if (meta.promptPath && realRoot) {
      const text = await readDepPrompt(root, realRoot, meta.promptPath);
      if (text !== null) ids = parseDependencyGateIds(text);
    }
    const unmet = ids.filter((id) => !merged.has(id));
    if (unmet.length > 0) rows.push({ job, lane: meta.lane, unmet });
    else if (includeMet && ids.length > 0) met.push({ job, lane: meta.lane, gates: ids });
    if (rows.length >= 50 && (!includeMet || met.length >= 50)) break;
  }
  return { unmetDeps: rows, metDeps: includeMet ? met : undefined };
}

/**
 * Path whose realpath reports an open descriptor's own location, where the OS
 * provides one. Linux /proc/self/fd entries are symlinks to the pinned inode's
 * path, so a swapped directory symlink cannot relabel what open() captured.
 * macOS /dev/fd nodes are character devices whose realpath yields only a
 * basename and Windows has no descriptor path; on both, the canonical re-open
 * below carries the containment proof instead.
 */
function descriptorPath(fd: number): string | null {
  return process.platform === 'linux' || process.platform === 'android'
    ? `/proc/self/fd/${fd}`
    : null;
}

/**
 * Read at most MAX_PROMPT bytes of a DEP prompt that must stay physically
 * inside the runs dir. Absolute paths are normalized before the lexical
 * containment check, and the open uses O_NOFOLLOW so a symlinked final
 * component is refused. Containment is then proven against the held
 * descriptor, not the name — realpath() and lstat() re-walk a mutable
 * namespace, so a flipped intermediate symlink could present "inside" to the
 * checks while open() and the read land outside:
 *
 *   - where the kernel reports an fd's path (Linux /proc/self/fd), the
 *     descriptor's own location must sit beneath the root;
 *   - everywhere, the canonical spelling of the path — which carries no
 *     symlinks — is re-opened and must name the same inode the descriptor
 *     pinned. A flip can steer open() or realpath(), but cannot make the
 *     canonical name resolve to the same outside inode;
 *   - an observed name or namespace change discards the read.
 *
 * Node has no portable descriptor-relative openat(2) or F_GETPATH, so a
 * same-user attacker renaming real directories underneath the tree can still
 * race the probes; the before/after checks make those swaps observable and
 * fail closed, matching the rest of the tree's acknowledged limit.
 */
async function readDepPrompt(root: string, realRootWithSep: string, promptPath: string): Promise<string | null> {
  const resolved = isAbsolute(promptPath) ? resolve(promptPath) : resolve(root, 'queue', promptPath);
  const rootAbs = resolve(root);
  const rootWithSep = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  if (!resolved.startsWith(rootWithSep)) return null;
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let canonical: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(resolved, constants.O_RDONLY | noFollow | nonBlock);
    const opened = await file.stat();
    if (!opened.isFile()) return null;
    const fdPath = descriptorPath(file.fd);
    if (fdPath !== null) {
      const fdReal = await realpath(fdPath).then((value) => value, () => null);
      if (fdReal !== null && !fdReal.startsWith(realRootWithSep)) return null;
    }
    const real = await realpath(resolved);
    if (!real.startsWith(realRootWithSep)) return null;
    canonical = await open(real, constants.O_RDONLY | noFollow | nonBlock);
    const rebound = await canonical.stat();
    if (!rebound.isFile() || rebound.dev !== opened.dev || rebound.ino !== opened.ino) return null;
    const size = Math.min(opened.size, MAX_PROMPT);
    const buffer = Buffer.alloc(size);
    let length = 0;
    while (length < size) {
      const { bytesRead } = await file.read(buffer, length, size - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const named = await lstat(resolved);
    const realAfter = await realpath(resolved).then((value) => value, () => '');
    if (named.isSymbolicLink() || !named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino ||
        realAfter !== real) return null;
    return buffer.subarray(0, length).toString('utf8');
  } catch { return null; }
  finally {
    await file?.close().catch(() => undefined);
    await canonical?.close().catch(() => undefined);
  }
}
