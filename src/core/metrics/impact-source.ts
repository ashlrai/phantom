/** Offline, bounded import boundary. Imported evidence never authorizes actions. */
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ImpactInput, ImpactOverride } from './impact.js';

export const IMPACT_SOURCE_VERSION = 'phantom-impact-source/v1';
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 20_000;
const MAX_NODES = 2_000;
const CHURN_MS = 48 * 60 * 60 * 1000;
type Row = Record<string, unknown>;
function invalid(context: string): never { throw new Error(`Invalid impact ${context}.`); }
function object(value: unknown, context: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(context);
  return value as Row;
}
function string(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return invalid(context);
  return value;
}
function strings(value: unknown, context: string, field?: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) return invalid(context);
  return [...new Set(value.map(v => string(typeof v === 'string' ? v : field ? object(v, context)[field] : v, context)))].sort();
}
function number(value: unknown, context: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid(context);
  return value;
}
function timestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return invalid('merge timestamp');
  const normalized = new Date(value).toISOString();
  const expected = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, ms: string) => `.${ms.padEnd(3, '0')}Z`) : value.replace('Z', '.000Z');
  if (normalized !== expected) return invalid('merge timestamp');
  return normalized;
}
function parse(text: string, context: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return invalid(`${context} JSON`); }
}

interface ImportedJob { input: ImpactInput; jobId: string; reverts?: string; fixedForwardFor?: string }
function importJob(value: unknown): ImportedJob {
  const row = object(value, 'job');
  if (row.schemaVersion !== undefined && row.schemaVersion !== 1) return invalid('job schema version');
  const jobId = string(row.id, 'job id');
  const repo = string(row.repo, 'repository');
  const pr = row.pr === undefined ? undefined : object(row.pr, 'PR');
  const prNumber = pr ? number(pr.number, 'PR number') : undefined;
  if (pr && (!prNumber || !Number.isSafeInteger(prNumber))) return invalid('PR number');
  const mergedAt = timestamp(pr?.mergedAt);
  const rawStatus = row.status;
  if (!['merged', 'failed', 'empty', 'pending', 'done'].includes(rawStatus as string)) return invalid('job status');
  // A completed job or an asserted merge alone cannot manufacture a landed PR.
  if (rawStatus === 'merged' && !mergedAt) return invalid('merged job without PR merge metadata');
  const status: ImpactInput['status'] = mergedAt ? 'merged' : rawStatus === 'failed' ? 'failed' : rawStatus === 'empty' ? 'empty' : 'pending';
  const input: ImpactInput = {
    id: pr ? `${repo}#${prNumber}` : `${repo}:${jobId}`, repo, status,
    ...(row.template === undefined ? {} : { template: string(row.template, 'template') }),
    tokens: number(row.tokens, 'tokens'),
    additions: number(pr?.additions ?? row.additions, 'additions'),
    deletions: number(pr?.deletions ?? row.deletions, 'deletions'),
    files: (pr?.files ?? row.files) === undefined ? undefined : strings(pr?.files ?? row.files, 'files', 'path'),
    labels: strings(pr?.labels ?? row.labels, 'labels', 'name'),
    tags: strings(row.tags, 'tags'), mergedAt,
  };
  return { input, jobId,
    ...(pr?.reverts === undefined ? {} : { reverts: string(pr.reverts, 'revert reference') }),
    ...(pr?.fixedForwardFor === undefined ? {} : { fixedForwardFor: string(pr.fixedForwardFor, 'fix-forward reference') }),
  };
}

interface QueueNode { key: string; repo?: string; dependsOn: string[]; tags: string[] }
function queueNodes(value: unknown): QueueNode[] {
  if (!Array.isArray(value)) {
    const root = object(value, 'queue graph');
    if (root.schemaVersion !== undefined && root.schemaVersion !== 1) return invalid('queue schema version');
  }
  const rows = Array.isArray(value) ? value : object(value, 'queue graph').nodes;
  if (!Array.isArray(rows) || rows.length > MAX_NODES) return invalid('queue nodes');
  const nodes = rows.map(value => {
    const row = object(value, 'queue node');
    const dependsOn = strings(row.dependsOn, 'queue dependencies');
    if (dependsOn.length > 128) return invalid('queue dependency count');
    return { key: string(row.key ?? row.id, 'queue key'),
      repo: row.repo == null ? undefined : string(row.repo, 'queue repo'),
      dependsOn, tags: strings(row.tags, 'queue tags') };
  });
  if (new Set(nodes.map(n => n.key)).size !== nodes.length) return invalid('duplicate queue key');
  return nodes;
}

/** Counts unique transitive dependents and longest downstream path, never priority guesses. */
function applyGraph(jobs: ImportedJob[], nodes: QueueNode[]): void {
  const byKey = new Map(nodes.map(n => [n.key, n]));
  const children = new Map(nodes.map(n => [n.key, [] as string[]]));
  const remaining = new Map(nodes.map(n => [n.key, n.dependsOn.length]));
  for (const node of nodes) for (const dependency of node.dependsOn) {
    if (!byKey.has(dependency)) return invalid('dangling queue dependency');
    children.get(dependency)!.push(node.key);
  }
  const ordered = nodes.filter(n => !n.dependsOn.length).map(n => n.key);
  for (let i = 0; i < ordered.length; i++) for (const child of children.get(ordered[i])!) {
    remaining.set(child, remaining.get(child)! - 1);
    if (remaining.get(child) === 0) ordered.push(child);
  }
  if (ordered.length !== nodes.length) return invalid('cyclic queue graph');
  const depth = new Map<string, number>();
  for (const key of [...ordered].reverse()) depth.set(key, Math.max(0, ...children.get(key)!.map(c => 1 + depth.get(c)!)));
  const cached = new Map<string, { dependentJobs: number; criticalPathDepth: number; repos: string[] }>();
  for (const job of jobs) {
    const node = byKey.get(job.jobId);
    if (!node) continue;
    if (node.repo && node.repo !== job.input.repo) return invalid('queue repository mismatch');
    let metrics = cached.get(node.key);
    if (!metrics) {
      const descendants = new Set<string>();
      const todo = [...children.get(node.key)!];
      while (todo.length) {
        const key = todo.pop()!;
        if (descendants.has(key)) continue;
        descendants.add(key);
        todo.push(...children.get(key)!);
      }
      metrics = { dependentJobs: descendants.size, criticalPathDepth: depth.get(node.key)!,
        repos: [...new Set([...descendants].map(k => byKey.get(k)!.repo).filter((r): r is string => !!r))] };
      cached.set(node.key, metrics);
    }
    job.input.dependentJobs = metrics.dependentJobs;
    job.input.criticalPathDepth = metrics.criticalPathDepth;
    job.input.repoBreadth = new Set([job.input.repo, ...metrics.repos]).size;
    job.input.tags = [...new Set([...(job.input.tags ?? []), ...node.tags])].sort();
  }
}

export function parseImpactOverrides(value: unknown): Record<string, ImpactOverride> {
  const root = object(value, 'overrides');
  if (root.schemaVersion !== 1) return invalid('override schema version');
  const entries = object(root.overrides, 'override entries');
  const allowed = new Set(['capability', 'autonomy', 'unblocking', 'fleetLoop', 'productionReach', 'repoBreadth', 'novelty', 'riskTier', 'trivial']);
  const out: Record<string, ImpactOverride> = Object.create(null) as Record<string, ImpactOverride>;
  for (const [id, raw] of Object.entries(entries)) {
    string(id, 'override id');
    const row = object(raw, 'override entry');
    for (const [key, value] of Object.entries(row)) {
      if (!allowed.has(key)) return invalid('override field');
      if (key === 'trivial' ? typeof value !== 'boolean' : key === 'riskTier' ? ![1, 2, 3].includes(value as number) : typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return invalid('override value');
    }
    out[id] = row as ImpactOverride;
  }
  return out;
}

export function importImpactJobs(text: string, graph?: unknown): ImpactInput[] {
  if (Buffer.byteLength(text) > MAX_BYTES) return invalid('ledger size');
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length > MAX_ROWS) return invalid('ledger row count');
  const jobs = lines.map((line, i) => importJob(parse(line, `job line ${i + 1}`)));
  // Repeated byte-equivalent snapshots do not multiply reward or churn. A
  // conflicting PR snapshot needs upstream reconciliation rather than guessing.
  const unique = new Map<string, ImportedJob>();
  for (const job of jobs) {
    const prior = unique.get(job.input.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(job)) return invalid('conflicting duplicate job or PR');
    unique.set(job.input.id, job);
  }
  const inputs = [...unique.values()];
  if (graph !== undefined) applyGraph(inputs, queueNodes(graph));
  const byId = new Map(inputs.map(j => [j.input.id, j.input]));
  const revertedAt = new Map<string, number>();
  const fixedAt = new Map<string, number>();
  for (const job of inputs) if (job.input.status === 'merged') {
    const at = Date.parse(job.input.mergedAt!);
    for (const ref of [job.reverts, job.fixedForwardFor]) if (ref) {
      const target = byId.get(ref);
      if (!target || target.id === job.input.id || target.repo !== job.input.repo || target.status !== 'merged'
        || Date.parse(target.mergedAt!) >= at) return invalid('revert or fix-forward reference chronology');
    }
    if (job.reverts) revertedAt.set(job.reverts, Math.max(at, revertedAt.get(job.reverts) ?? 0));
    if (job.fixedForwardFor) fixedAt.set(job.fixedForwardFor, Math.max(at, fixedAt.get(job.fixedForwardFor) ?? 0));
  }
  for (const [id, at] of revertedAt) {
    byId.get(id)!.reverted = true;
    byId.get(id)!.fixedForward = (fixedAt.get(id) ?? 0) > at;
  }
  const lastChange = new Map<string, number>();
  const chronological = inputs.map(j => j.input).filter(i => i.status === 'merged').sort((a, b) => a.mergedAt!.localeCompare(b.mergedAt!) || a.id.localeCompare(b.id));
  for (const input of chronological) {
    const at = Date.parse(input.mergedAt!);
    input.churnFiles = 0;
    for (const file of input.files ?? []) {
      const key = JSON.stringify([input.repo, file]);
      const previous = lastChange.get(key);
      if (previous !== undefined && at - previous <= CHURN_MS) input.churnFiles++;
      lastChange.set(key, at);
    }
  }
  return inputs.map(j => j.input).sort((a, b) => a.id.localeCompare(b.id));
}

async function readBounded(path: string): Promise<string> {
  // Nonblocking open prevents a named pipe from hanging this read-only command.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return invalid('source file size or kind');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_BYTES) return invalid('source file size');
    return buffer.toString('utf8', 0, used);
  } finally { await file.close(); }
}

export interface ImpactSourceOptions { jobs?: string; queue?: string; overrides?: string }
export async function readImpactSource(options: ImpactSourceOptions = {}) {
  const configured = process.env['ASHLR_HOME'];
  const home = configured && isAbsolute(configured) ? configured : join(homedir(), '.ashlr');
  const jobsPath = options.jobs ?? join(home, 'metrics', 'jobs.jsonl');
  let text: string;
  try { text = await readBounded(jobsPath); }
  catch (error) {
    if (!options.jobs && !options.queue && !options.overrides && (error as NodeJS.ErrnoException).code === 'ENOENT') return { inputs: [], overrides: {}, complete: false, warnings: ['No local metrics/jobs.jsonl source. Import job and PR evidence to score impact.'] };
    throw new Error('Cannot read impact jobs source.');
  }
  // No catch-and-empty behavior for malformed, unreadable or partial evidence.
  const graph = options.queue ? parse(await readBounded(options.queue), 'queue') : undefined;
  const overrides = options.overrides ? parseImpactOverrides(parse(await readBounded(options.overrides), 'overrides')) : {};
  const inputs = importImpactJobs(text, graph);
  const ids = new Set(inputs.map(i => i.id));
  if (Object.keys(overrides).some(id => !ids.has(id))) return invalid('override target');
  return { inputs, overrides, complete: true, warnings: [] as string[] };
}
