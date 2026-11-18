import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { z } from 'zod';
import { readKillState, readPauseState } from '../comms-agent/policy.js';
import { TASK_CLASSES } from '../decide/registry.js';
import { postureEvidence } from '../queue/route-explain.js';
import { loadRouteSources } from '../routing/decision-candidates.js';
import { routeIdSchema, routeRequestSchema, routeTierSchema, type RouteDecision } from '../routing/decision-schema.js';
import { decideRoute } from '../routing/decision.js';

export const MAX_SUBAGENT_DEPTH = 3;
const tools = ['read', 'search', 'edit', 'test', 'shell', 'web'] as const;
const costSchema = z.enum(['local', 'included', 'metered']);
const idSchema = z.string().regex(/^sa-[a-f0-9]{16}$/);
const parentSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const subagentRecordSchema = z.object({
  schema: z.literal('subagent.v1'), id: idSchema, parent_id: parentSchema,
  depth: z.number().int().positive(), tier: routeTierSchema,
  lane: routeIdSchema.nullable(), model: z.string().nullable(),
  tools_allowed: z.array(z.enum(tools)), write_scope: z.array(z.string()),
  max_tokens: z.number().int().positive(), max_cost_class: costSchema,
  state: z.enum(['planned', 'held', 'refused', 'running', 'completed', 'failed']),
  result_ref: z.string().nullable(), created_at: z.string().datetime(),
  reason_codes: z.array(z.string()), task_digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SubagentRecord = z.infer<typeof subagentRecordSchema>;
export interface SubagentOptions {
  home?: string; runsRoot?: string; nowMs?: number;
  kill?: () => 'active' | 'inactive' | 'unknown'; paused?: () => boolean;
}
export interface SubagentSpawnInput {
  parent_id: string; tier: SubagentRecord['tier']; task: string;
  tools_allowed?: string[]; write_scope?: string[]; max_tokens?: number;
  max_cost_class?: SubagentRecord['max_cost_class']; task_class?: typeof TASK_CLASSES[number];
  repo?: string; apply?: boolean;
}
const costRank = { local: 0, included: 1, metered: 2 };
const tierRank = { fast: 0, mid: 1, work: 2, frontier: 3 };
const tokens = { fast: 16000, mid: 32000, work: 64000, frontier: 200000 };
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const store = (options: SubagentOptions) => join(options.home ?? homedir(), '.ashlr/subagents');

async function readBounded(path: string): Promise<unknown> {
  try {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) return null;
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      return bytesRead > 1024 * 1024 ? null : JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally { await fd.close(); }
  } catch { return null; }
}

export async function readSubagentRecord(id: string, options: SubagentOptions = {}): Promise<SubagentRecord | null> {
  if (!idSchema.safeParse(id).success) return null;
  const parsed = subagentRecordSchema.safeParse(await readBounded(join(store(options), `${id}.json`)));
  return parsed.success && parsed.data.id === id ? parsed.data : null;
}

export async function writeSubagentRecord(record: SubagentRecord, options: SubagentOptions = {}): Promise<void> {
  const valid = subagentRecordSchema.parse(record);
  const dir = store(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${valid.id}-${randomBytes(8).toString('hex')}.tmp`);
  try {
    const fd = await open(tmp, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(valid) + '\n'); } finally { await fd.close(); }
    await rename(tmp, join(dir, `${valid.id}.json`));
  } finally { await unlink(tmp).catch(() => {}); }
}

function normalizeScope(path: string): string | null {
  if (!path || path.includes('\0') || posix.isAbsolute(path) || win32.isAbsolute(path)) return null;
  const slashes = path.replaceAll('\\', '/');
  if (slashes.split('/').includes('..')) return null;
  const normalized = posix.normalize(slashes).replace(/^\.\//, '');
  return normalized === '.' || (normalized.includes('*') && normalized !== '**' && !/^[^*]+\/\*\*$/.test(normalized)) ? null : normalized;
}
const contains = (parent: string, child: string) => {
  if (parent === '**' || parent === child) return true;
  const prefix = parent.endsWith('/**') ? parent.slice(0, -2) : parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(prefix);
};

export async function planSubagentSpawn(input: SubagentSpawnInput, options: SubagentOptions = {}) {
  const existing = await readSubagentRecord(input.parent_id, options);
  const parent = { id: input.parent_id, depth: existing?.depth ?? 0, kind: existing ? 'subagent' as const : 'root' as const };
  const scope: Pick<SubagentRecord, 'tier' | 'tools_allowed' | 'write_scope' | 'max_tokens' | 'max_cost_class'> = existing ?? {
    tier: 'frontier', tools_allowed: ['read', 'search', 'edit', 'test', 'shell'], write_scope: ['**'], max_tokens: 200000, max_cost_class: 'included',
  };
  const record: SubagentRecord = {
    schema: 'subagent.v1', id: `sa-${randomBytes(8).toString('hex')}`, parent_id: input.parent_id,
    depth: parent.depth + 1, tier: input.tier, tools_allowed: (input.tools_allowed ?? scope.tools_allowed) as SubagentRecord['tools_allowed'],
    write_scope: input.write_scope ?? scope.write_scope, max_tokens: input.max_tokens ?? Math.min(scope.max_tokens, tokens[input.tier]),
    max_cost_class: input.max_cost_class ?? scope.max_cost_class, lane: null, model: null, state: 'planned', result_ref: null,
    created_at: new Date(options.nowMs ?? Date.now()).toISOString(), reason_codes: [],
    task_digest: createHash('sha256').update(input.task).digest('hex'),
  };
  const routing: { decision: RouteDecision | null; eligible_lanes: string[]; excluded_lanes: { lane: string; reason: string }[] } = { decision: null, eligible_lanes: [], excluded_lanes: [] };
  const reasons: string[] = [];
  if (idSchema.safeParse(input.parent_id).success && !existing) reasons.push('parent-not-found');
  if (existing && !['planned', 'held', 'running'].includes(existing.state)) reasons.push('parent-state-invalid');
  if (!parentSchema.safeParse(input.parent_id).success || !routeTierSchema.safeParse(input.tier).success || !input.task.trim()) reasons.push('input-invalid');
  if (record.depth > MAX_SUBAGENT_DEPTH) reasons.push('depth-exceeded');
  if (record.tools_allowed.some(t => !(tools as readonly string[]).includes(t))) reasons.push('tool-unknown');
  if (record.tools_allowed.some(t => !scope.tools_allowed.includes(t))) reasons.push('scope-tools-not-subset');
  const paths = record.write_scope.map(normalizeScope);
  if (paths.some(p => p === null)) reasons.push('write-scope-invalid');
  else {
    record.write_scope = paths as string[];
    if (record.write_scope.some(p => !scope.write_scope.some(s => contains(s, p)))) reasons.push('scope-write-not-subset');
  }
  if (!costSchema.safeParse(record.max_cost_class).success || costRank[record.max_cost_class] > costRank[scope.max_cost_class]) reasons.push('scope-cost-not-subset');
  if (!Number.isSafeInteger(record.max_tokens) || record.max_tokens <= 0 || record.max_tokens > scope.max_tokens) reasons.push('scope-tokens-not-subset');
  if (tierRank[record.tier] > tierRank[scope.tier]) reasons.push('scope-tier-not-subset');
  if ((options.kill ?? readKillState)() !== 'inactive') reasons.push('kill-engaged');
  const paused = (options.paused ?? readPauseState)();
  if (paused) reasons.push('paused');
  if (!reasons.length) {
    const root = options.runsRoot ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
    const sources = await loadRouteSources(root);
    const posture = await postureEvidence(root);
    const lanes = Object.keys(object(sources.slots)).filter(l => routeIdSchema.safeParse(l).success).sort();
    for (const lane of lanes) {
      const cost = posture?.lanes[lane]?.costClass ?? (/^local$|^local-|-local$/.test(lane) ? 'local' : 'metered');
      if (costRank[cost as keyof typeof costRank] > costRank[record.max_cost_class]) routing.excluded_lanes.push({ lane, reason: 'scope-cost-not-subset' });
      else routing.eligible_lanes.push(lane);
    }
    const status = object(await readBounded(join(root, 'queue/status.json')));
    const running: Record<string, number> = {};
    for (const lane of lanes) {
      const n = object(object(status.lanes)[lane]).running;
      if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) running[lane] = n;
    }
    const request = routeRequestSchema.safeParse({ task_class: input.task_class ?? 'other', repo: input.repo ?? 'phantom', tier_hint: input.tier,
      lane_candidates: routing.eligible_lanes, quota_state: Object.fromEntries(lanes.map(l => [l,
        object(object(sources.slots)[l]).held || object(object(sources.capacity)[l]).remainingPercent === 0 ? 'exhausted' : 'available'])),
      machine_state: { admit: object(sources.admission).admit === true && !paused, running_by_lane: running } });
    if (!request.success) reasons.push('input-invalid');
    else {
      const decision = await decideRoute(request.data, sources, { backends: [], nowMs: options.nowMs });
      if ('lane' in decision) {
        routing.decision = decision;
        record.lane = decision.lane; record.model = decision.model;
        reasons.push(...decision.reason_codes);
      }
      if (!record.lane) reasons.unshift('no-eligible-lane-quota');
    }
  }
  const ok = record.lane !== null && !reasons.includes('no-eligible-lane-quota');
  record.state = ok ? input.apply ? 'held' : 'planned' : 'refused';
  if (ok && input.apply) reasons.push('apply-inert-no-scoped-live-path');
  record.reason_codes = [...new Set(reasons)];
  if (ok && input.apply) await writeSubagentRecord(record, options);
  return { schema: 'subagent.spawn.v1' as const, ok, dry_run: !input.apply, applied: false as const, record, parent, routing,
    reason_codes: record.reason_codes,
    next_step: 'Wire child scope into the dispatch admission path (dispatchd/node-router lease carries subagent scope and the sandbox enforces write_scope) under Security review, then flip held to dispatched.' };
}

/** Every valid subagent record, oldest first, at most `limit`. A missing store is an empty list. */
export async function readSubagentRecords(options: SubagentOptions = {}, limit = 500): Promise<SubagentRecord[]> {
  const names = await readdir(store(options)).catch(() => [] as string[]);
  const records = await Promise.all(names.filter(n => n.endsWith('.json')).slice(0, limit).map(n => readSubagentRecord(n.slice(0, -5), options)));
  return records.filter((r): r is SubagentRecord => r !== null).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function listSubagents(parentId: string, options: SubagentOptions = {}) {
  const subagents = (await readSubagentRecords(options, Infinity)).filter(r => r.parent_id === parentId);
  return { schema: 'subagent.list.v1' as const, parent_id: parentId, count: subagents.length, subagents };
}
