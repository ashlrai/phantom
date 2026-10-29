/** Offline proposal planner. Nothing here executes job text or grants authority. */
import { createHash } from 'node:crypto';
import { scoreItem, sourceTierMultiplier } from './scoring.js';

export const RQ_MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 20_000;
const REPO_RE = /^ashlrai\/[a-z0-9][a-z0-9._-]{0,99}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,179}$/;
const STATES = ['READY', 'RUNNING', 'BLOCKED', 'DONE', 'FAILED', 'CANCELLED'] as const;
const SOURCES = ['vision', 'issue', 'scan'] as const;
const SCAN_SOURCES = ['issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint', 'goal', 'hygiene', 'invent'];

export interface RqConfig {
  v: 1;
  activeSlots: number;
  allowedRepos: string[];
}

export interface RqJob {
  v: 1;
  id: string;
  repo: string;
  status: typeof STATES[number];
  source: typeof SOURCES[number];
  sourceId: string;
  title: string;
  /** Untrusted task data, for a model prompt only. Never shell input. */
  prompt: string;
}

interface Candidate extends RqJob { score: number }

export interface RqPlan {
  jobs: RqJob[];
  ready: number;
  minimum: number;
  target: number;
  /** Remaining gap to target after exhausting available grounded candidates. */
  shortfall: number;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid or oversized array');
  return value;
}

function hasControl(value: string, multiline: boolean): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code)))) return true;
  }
  return false;
}

function text(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
    hasControl(value, multiline)) {
    throw new Error('Invalid text field');
  }
  return value.trim();
}

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error('Invalid integer');
  return value as number;
}

function member<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error('Invalid enum field');
  return value as T;
}

function repo(value: unknown, config: RqConfig): string {
  if (typeof value !== 'string' || !config.allowedRepos.includes(value)) throw new Error('Repository is not allowed');
  return value;
}

export function parseRqConfig(value: unknown): RqConfig {
  const row = object(value);
  if (row['v'] !== 1) throw new Error('Unsupported config version');
  const allowedRepos = array(row['allowedRepos'], 7);
  if (allowedRepos.length !== 7 || new Set(allowedRepos).size !== 7 ||
    !allowedRepos.every((name): name is string => typeof name === 'string' && REPO_RE.test(name))) {
    throw new Error('Configure exactly seven distinct ashlrai repositories');
  }
  return { v: 1, activeSlots: integer(row['activeSlots'], 0, 1000), allowedRepos };
}

export const rqDigest = (value: string): string => createHash('sha256').update(value).digest('hex');
// Same title convention as the cloud backlog: case, punctuation and space do
// not create another task. Preserve Unicode letters to avoid empty non-ASCII keys.
const titleKey = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const objectiveKey = (job: RqJob): string => `${job.repo}:${job.source}:${job.sourceId}`;
const workKey = (job: RqJob): string => `${job.repo}:${titleKey(job.title) || rqDigest(job.title)}`;

/** Invalid queue data is unknown, never an empty queue. No partial admission. */
export function parseRqQueue(contents: string, config: RqConfig): RqJob[] {
  if (Buffer.byteLength(contents) > RQ_MAX_FILE_BYTES) throw new Error('Queue is too large');
  const jobs: RqJob[] = [];
  const ids = new Set<string>();
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    if (jobs.length >= MAX_ROWS) throw new Error('Too many queue rows');
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('Queue must contain JSON Lines'); }
    const row = object(value);
    const id = text(row['id'], 180);
    if (row['v'] !== 1 || !ID_RE.test(id) || ids.has(id)) throw new Error('Invalid or duplicate queue identity');
    const job: RqJob = {
      v: 1, id, repo: repo(row['repo'], config), status: member(row['status'], STATES),
      source: member(row['source'], SOURCES), sourceId: text(row['sourceId'], 200),
      title: text(row['title'], 240), prompt: text(row['prompt'], 20_000, true),
    };
    ids.add(id);
    jobs.push(job);
  }
  return jobs;
}

/** Structured queue diff: hashes and identities only, never task/diff text. */
export function rqQueueDiff(before: string, after: string, config: RqConfig) {
  const prior = new Map(parseRqQueue(before, config).map((job) => [job.id, job]));
  const current = new Map(parseRqQueue(after, config).map((job) => [job.id, job]));
  const summary = (job: RqJob) => ({ id: job.id, repo: job.repo, status: job.status, sha: rqDigest(JSON.stringify(job)) });
  return {
    event: 'rq-queue-read' as const, beforeSha: rqDigest(before), sha: rqDigest(after),
    added: [...current.values()].filter((job) => !prior.has(job.id)).map(summary),
    removed: [...prior.values()].filter((job) => !current.has(job.id)).map(summary),
    changed: [...current.values()].filter((job) => {
      const old = prior.get(job.id);
      return old && JSON.stringify(old) !== JSON.stringify(job);
    }).map((job) => ({ before: summary(prior.get(job.id)!), after: summary(job) })),
  };
}

function candidate(repository: string, source: RqJob['source'], sourceId: string, title: string, prompt: string, score: number): Candidate {
  return {
    v: 1, id: `RQ-${rqDigest(JSON.stringify([repository, source, sourceId])).slice(0, 24)}`,
    repo: repository, status: 'READY', source, sourceId, title, prompt, score,
  };
}

function candidates(value: unknown, config: RqConfig): Candidate[] {
  const input = object(value);
  if (input['v'] !== 1) throw new Error('Unsupported source version');
  const result: Candidate[] = [];
  const seenRepos = new Set<string>();
  for (const raw of array(input['repositories'], 7)) {
    const row = object(raw);
    const repository = repo(row['repo'], config);
    if (seenRepos.has(repository)) throw new Error('Duplicate source repository');
    seenRepos.add(repository);
    // Only explicit unchecked tasks are actionable. Narrative and completed
    // checkboxes never become invented work just to fill capacity.
    const vision = row['vision'];
    if (typeof vision !== 'string' || vision.length > 128_000) throw new Error('Invalid VISION snapshot');
    let fenced = false;
    let fence = '';
    for (const [index, line] of vision.split(/\r?\n/).entries()) {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker) {
        const token = marker[1]!;
        if (!fenced) { fenced = true; fence = token; }
        else if (token[0] === fence[0] && token.length >= fence.length && /^\s{0,3}(?:`+|~+)\s*$/.test(line)) fenced = false;
        continue;
      }
      if (fenced) continue;
      const match = line.match(/^\s{0,3}[-*+] \[ \] (.+)$/);
      if (!match) continue;
      const title = text(match[1], 240);
      result.push(candidate(repository, 'vision', rqDigest(titleKey(title) || title), title,
        `VISION.md:${index + 1}\n${title}`, scoreItem(5, 2) * sourceTierMultiplier('goal')));
    }
    const issueIds = new Set<number>();
    for (const rawIssue of array(row['issues'], 1000)) {
      const issue = object(rawIssue);
      const number = integer(issue['number'], 1, Number.MAX_SAFE_INTEGER);
      if (issueIds.has(number)) throw new Error('Duplicate issue number');
      issueIds.add(number);
      const state = member(issue['state'], ['open', 'closed'] as const);
      const title = text(issue['title'], 240);
      const body = issue['body'] === '' ? '' : text(issue['body'], 16_000, true);
      if (state === 'closed') continue;
      result.push(candidate(repository, 'issue', String(number), title,
        `https://github.com/${repository}/issues/${number}\n${title}\n${body}`,
        scoreItem(3, 2) * sourceTierMultiplier('issue')));
    }
    const scanIds = new Set<string>();
    for (const rawScan of array(row['scans'], 1000)) {
      const scan = object(rawScan);
      const id = text(scan['id'], 180);
      if (scanIds.has(id)) throw new Error('Duplicate scan identity');
      scanIds.add(id);
      const source = member(scan['source'], SCAN_SOURCES);
      const title = text(scan['title'], 240);
      const detail = text(scan['detail'], 16_000, true);
      const value = integer(scan['value'], 1, 5);
      const effort = integer(scan['effort'], 1, 5);
      result.push(candidate(repository, 'scan', id, title, detail, scoreItem(value, effort) * sourceTierMultiplier(source)));
    }
  }
  return result;
}

/** Repeated calls on the applied queue are idempotent; history blocks replay. */
export function planRqBacklog(configValue: unknown, sourceValue: unknown, queueText: string): RqPlan {
  const config = parseRqConfig(configValue);
  const queue = parseRqQueue(queueText, config);
  const available = candidates(sourceValue, config);
  // Queue rows are untrusted: changing IDs on duplicate work must not inflate
  // capacity and suppress replenishment. Historical rows still block replay.
  const readyObjectives = new Set<string>();
  const readyTitles = new Set<string>();
  let ready = 0;
  for (const job of queue) {
    if (job.status !== 'READY') continue;
    const objective = objectiveKey(job);
    const title = workKey(job);
    if (!readyObjectives.has(objective) && !readyTitles.has(title)) ready++;
    readyObjectives.add(objective);
    readyTitles.add(title);
  }
  const minimum = config.activeSlots * 3;
  const target = config.activeSlots * 5;
  if (ready >= minimum) return { jobs: [], ready, minimum, target, shortfall: 0 };
  const ids = new Set(queue.map((job) => job.id));
  const objectives = new Set(queue.map(objectiveKey));
  const titles = new Set(queue.map(workKey));
  // Stable, locale-independent ordering even when snapshots arrive reordered.
  available.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const jobs: RqJob[] = [];
  // Preserve raw snapshot bytes (including whitespace), and reserve the JSONL
  // separator the bridge must insert when the existing last row lacks LF.
  let bytes = Buffer.byteLength(queueText) + (queueText && !queueText.endsWith('\n') ? 1 : 0);
  for (const item of available) {
    if (ready + jobs.length >= target || queue.length + jobs.length >= MAX_ROWS) break;
    const objective = objectiveKey(item);
    const title = workKey(item);
    if (ids.has(item.id) || objectives.has(objective) || titles.has(title)) continue;
    const { score: _score, ...job } = item;
    const size = Buffer.byteLength(formatRqQueue([job]));
    if (bytes + size > RQ_MAX_FILE_BYTES) break;
    bytes += size;
    jobs.push(job);
    ids.add(job.id);
    objectives.add(objective);
    titles.add(title);
  }
  return { jobs, ready, minimum, target, shortfall: Math.max(0, target - ready - jobs.length) };
}

export function formatRqQueue(jobs: readonly RqJob[]): string {
  return jobs.map((job) => JSON.stringify(job) + '\n').join('');
}
