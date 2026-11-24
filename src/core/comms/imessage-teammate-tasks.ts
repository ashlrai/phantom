/** Fleet-originated tasks. Peer results are evidence to review, never operator authority. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AshlrConfig } from '../types.js';
import { imessageStateDir } from '../integrations/imessage.js';
import { QueueStore } from '../queue/store.js';
import type { QueueJob } from '../queue/schema.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { scrubSecrets } from '../util/scrub.js';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { protocolOf, validateBusEnvelope } from '../fleet/bus-envelope.js';
import { markTeammateTextsAnswered, readTeammateTexts } from './imessage-teammate-inbox.js';
import { approvedTeammateHandle, reconcileTeammateMessage, sendApprovedTeammateMessage, type TeamTransportOptions } from './imessage-teammate-transport.js';

const SCHEMA = 'imessage.teammate-tasks.v1';
const MAX_BYTES = 4 * 1024 * 1024;
const DAY = 86400000;
const WITHDRAWAL = 'Operator withdrew unsent teammate task';
const PEERS = {
  dot: { senderId: 'imessage:e2e0809f8676fb7d', declared: 'Codex-backed; can claim RQ jobs (owner-described)' },
  instinct: { senderId: 'imessage:f5228be7cfedb6cb', declared: 'Independent agent; own GitHub access; PR rebase/triage (owner-described)' },
} as const;
/** Task peers use the envelope protocol; their prose is never a new local request. */
export function isTeammateTaskPeer(senderId: string): boolean {
  return Object.values(PEERS).some(peer => peer.senderId === senderId);
}
const safeText = (max: number) => z.string().trim().min(1).max(max)
  .refine(text => !/[\p{Cc}\p{Cf}]/u.test(text) && scrubSecrets(text) === text);
const millis = z.number().int().nonnegative().max(8640000000000000);
const rowid = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const inputSchema = z.object({
  jobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/).refine(text => scrubSecrets(text) === text),
  peer: z.enum(['dot', 'instinct']), kind: z.enum(['research', 'triage', 'report', 'rebase']),
  scope: safeText(1200), repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/).max(200).refine(text => scrubSecrets(text) === text),
  prRefs: z.array(rowid).max(20).default([]), format: safeText(300),
  deadline: z.string().datetime({ offset: true }),
}).strict();
const taskSchema = inputSchema.extend({
  token: z.string().regex(/^[a-f0-9]{32}$/), createdAt: millis,
  state: z.enum(['queued', 'sending', 'pending', 'replied', 'expired', 'cancelled']), attemptedAt: millis.optional(),
  receipt: z.object({ rowid, sent: z.boolean(), delivered: z.boolean(), error: z.number().finite() }).strict().optional(),
  result: z.object({ rowid, status: z.enum(['DONE', 'BLOCKED', 'FAILED']), summary: safeText(1600), at: millis }).strict().optional(),
  metrics: z.array(z.enum(['launch', 'finish'])).max(2).default([]),
  settled: z.boolean().default(false),
}).strict().refine(task =>
  (!['sending', 'pending', 'replied'].includes(task.state) || task.attemptedAt !== undefined)
  && (!['pending', 'replied'].includes(task.state) || task.receipt?.sent === true && task.receipt.error === 0)
  && (task.state === 'replied') === (task.result !== undefined)
  && (!task.result || task.result.rowid > task.receipt!.rowid)
  && (task.state !== 'cancelled' || task.attemptedAt === undefined && !task.receipt && task.metrics.length === 0)
  && (!task.settled || ['replied', 'expired', 'cancelled'].includes(task.state)));
const storeSchema = z.object({ v: z.literal(1), tasks: z.array(taskSchema).max(1024),
  attempts: z.object({ dot: z.array(millis).max(24), instinct: z.array(millis).max(24) }).strict(),
}).strict().refine(store => new Set(store.tasks.map(task => task.jobId)).size === store.tasks.length
  && new Set(store.tasks.map(task => task.token)).size === store.tasks.length);
export type TeammateTaskInput = z.input<typeof inputSchema>;
/** Bus-origin requests enter through the same guarded enqueue path as local requests. */
export type TeammateTaskRequest = TeammateTaskInput | { envelope: unknown };
type Task = z.infer<typeof taskSchema>;
type Store = z.infer<typeof storeSchema>;
export interface TeammateTaskOptions extends TeamTransportOptions {
  apply?: boolean; runsDir?: string; now?: () => number; signal?: AbortSignal;
  approved?: typeof approvedTeammateHandle; send?: typeof sendApprovedTeammateMessage; reconcile?: typeof reconcileTeammateMessage;
  busRoot?: string;
  /** Host-supplied provenance, never taken from wire labels, sender or body.
   * Missing provenance stays unknown. M2 has no remote authentication path. */
  busOrigin?: { principal: string | null; localPrincipal: string };
}
const paths = (options: TeammateTaskOptions) => {
  const dir = imessageStateDir(options.runsDir);
  return { dir, runs: dirname(dir), path: join(dir, 'teammate-tasks.json') };
};
function read(path: string, anchorPath: string, cap = MAX_BYTES): string | null {
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Teammate task state unavailable'); }
  const result = readStableRegularFile(path, { anchorPath, maxFileBytes: cap, remainingBytes: cap });
  if (!result.ok) throw new Error('Teammate task state unavailable');
  return result.text;
}
function load(options: TeammateTaskOptions): Store {
  const { path, dir } = paths(options);
  const raw = read(path, dir);
  if (raw === null) return { v: 1, tasks: [], attempts: { dot: [], instinct: [] } };
  try { return storeSchema.parse(JSON.parse(raw)); } catch { throw new Error('Teammate task state invalid'); }
}
function save(store: Store, options: TeammateTaskOptions): void {
  const { path, dir } = paths(options);
  const text = JSON.stringify(storeSchema.parse(store));
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Teammate task store full');
  writePrivateFileAtomically(join(dir, `.${randomUUID()}.tmp`), path, text, { anchorPath: dir, label: 'Teammate tasks' });
}
async function locked<T>(options: TeammateTaskOptions, operation: () => Promise<T>): Promise<T> {
  const { dir, runs } = paths(options);
  ensurePrivateDirectory(runs); ensurePrivateDirectory(dir);
  const held = acquireLocalStoreLockWithOutcome(join(dir, 'teammate-tasks.lock'), 0, { anchorPath: dir });
  if (held.state !== 'acquired') throw new Error('Teammate tasks busy');
  try { return await operation(); } finally { releaseLocalStoreLock(held.lock); }
}
const owner = (task: { peer: string }) => `imsg:${task.peer}`;
const acceptance = (task: { jobId: string; token: string }) => `RESULT ${task.jobId} ${task.token}; peer report only, independent verification required`;
/** The queue identity fields a teammate task reserves; internal evidence, never serialized publicly. */
export interface TeammateTaskQueueIdentity {
  jobId: string; peer: string; repo: string; scope: string; token: string;
}
/**
 * The exact queue-job identity syncQueue enforces on write, shared with the
 * read-only fleet MCP binding projection so both prove the same tuple: a
 * same-id/owner/repo row carrying a different scope or RESULT token is not
 * this task. Scope and token must never enter public output.
 */
export function teammateQueueJobMatchesIdentity(job: QueueJob, identity: TeammateTaskQueueIdentity): boolean {
  return job.acceptance === acceptance(identity) && job.claims.at(-1)?.owner === owner(identity)
    && job.repo === identity.repo && job.scope === identity.scope;
}
/** Internal jobId → reserved-identity index for the fleet MCP binding read; never serialized. */
export function teammateTaskQueueIdentities(options: TeammateTaskOptions = {}): Map<string, TeammateTaskQueueIdentity> {
  return new Map(load(options).tasks.map(task => [task.jobId, {
    jobId: task.jobId, peer: task.peer, repo: task.repo, scope: task.scope, token: task.token,
  }]));
}
/** A claim is reserved at insertion, so a lane hint cannot hand this task to a local executor. */
async function syncQueue(task: Task, options: TeammateTaskOptions): Promise<void> {
  const queue = new QueueStore(join(paths(options).runs, 'queue'));
  let job = (await queue.read()).jobs.find(job => job.id === task.jobId);
  if (!job && task.state === 'cancelled') throw new Error('Teammate queue claim conflict');
  if (!job) job = await queue.add({ id: task.jobId, status: 'CLAIMED', priority: 'P2', tier: 'work',
    repo: task.repo, scope: task.scope, acceptance: acceptance(task), deps: [], preferred_lane: `imsg-${task.peer}`,
    // QueueStore owns wall-clock claim/finish times; the injected task clock only
    // governs transport deadlines, cooldowns and evidence timestamps.
    needs: ['imessage'], exclusive: true, claims: [{ owner: owner(task), claimedAt: new Date().toISOString() }] });
  if (!teammateQueueJobMatchesIdentity(job, task)) throw new Error('Teammate queue claim conflict');
  const terminal = ['replied', 'expired', 'cancelled'].includes(task.state);
  const reason = task.state === 'cancelled' ? WITHDRAWAL : task.state === 'expired' ? 'Teammate deadline elapsed; remote execution is unknown'
    : task.result?.status !== 'DONE' ? `Teammate reported ${task.result?.status}; review private result` : undefined;
  const expected = terminal ? reason ? 'BLOCKED' : 'DONE' : 'CLAIMED';
  if (terminal && job.status === 'CLAIMED' && !job.claims.at(-1)?.finishedAt) {
    await queue.finish(task.jobId, owner(task), { reason });
  } else if (job.status !== expected || (!terminal && job.claims.at(-1)?.finishedAt)
    || task.state === 'cancelled' && (job.blockedReason !== WITHDRAWAL || !job.claims.at(-1)?.finishedAt)) throw new Error('Teammate queue claim changed');
}
function view(task: Task) {
  // Operational output never includes scopes, outgoing bodies, raw handles or result text.
  const { scope: _scope, format: _format, result, ...metadata } = task;
  return { ...metadata, resource: owner(task), claimKey: `queue:imsg.${task.peer}.${task.jobId}`,
    result: result ? { rowid: result.rowid, status: result.status, at: result.at, evidence: 'peer-reported' } : null };
}
export function listTeammateTasks(options: TeammateTaskOptions = {}) {
  return { schema: SCHEMA, state: 'healthy', tasks: load(options).tasks.map(view) };
}
export function teammateTaskPeers(options: TeammateTaskOptions = {}) {
  const tasks = load(options).tasks;
  return { schema: SCHEMA, peers: Object.entries(PEERS).map(([peer, profile]) => ({ peer, ...profile,
    resource: `imsg:${peer}`, declaredEvidence: 'owner-described',
    observed: tasks.filter(task => task.peer === peer && task.result?.status === 'DONE')
      .map(task => ({ kind: task.kind, jobId: task.jobId, rowid: task.result!.rowid, at: task.result!.at, evidence: 'peer-reported' })),
  })) };
}
export async function enqueueTeammateTask(input: TeammateTaskRequest, cfg: AshlrConfig, options: TeammateTaskOptions = {}) {
  if ('envelope' in input) {
    const checked = validateBusEnvelope(input.envelope);
    if (!checked.ok) throw new Error('Invalid teammate bus envelope');
    const envelope = checked.value;
    // Keep the original as inert context in the existing bus, including for
    // unknown origins. A stored foreign task must not become claimable work.
    const retained = appendBusInbox({ id: `teammate-data-${createHash('sha256').update(envelope.id).digest('hex')}`,
      from: envelope.from, to: envelope.to, priority: envelope.priority, ttl: envelope.ttl,
      body: { kind: 'context', text: scrubSecrets(JSON.stringify(envelope)) },
    }, { root: options.busRoot, now: options.now });
    if (!['posted', 'duplicate'].includes(retained.status)) throw new Error('Teammate envelope storage unavailable');
    const origin = options.busOrigin;
    if (!origin || !/^(?:local|own_[a-f0-9]{32})(?![\s\S])/.test(origin.localPrincipal)
      || origin.principal !== origin.localPrincipal) {
      return { schema: SCHEMA, state: 'data-only', dryRun: !options.apply };
    }
    const peer = envelope.to === 'agent:imsg-dot' ? 'dot' : envelope.to === 'agent:imsg-instinct' ? 'instinct' : null;
    if (!peer || protocolOf(envelope.body)?.kind !== 'task') return { schema: SCHEMA, state: 'data-only', dryRun: !options.apply };
    const task = inputSchema.safeParse((envelope.body as { task?: unknown }).task);
    if (!task.success || task.data.peer !== peer) throw new Error('Invalid teammate bus task');
    input = task.data;
  }
  const parsed = inputSchema.safeParse(input);
  const now = (options.now ?? Date.now)();
  if (!parsed.success || !Number.isSafeInteger(now) || Date.parse(parsed.data.deadline) <= now) throw new Error('Invalid teammate task or deadline');
  const data = { ...parsed.data, prRefs: [...new Set(parsed.data.prRefs)].sort((a, b) => a - b) };
  const enqueue = async () => {
    const store = load(options);
    const existing = store.tasks.find(task => task.jobId === data.jobId);
    if (existing && JSON.stringify(inputSchema.parse(existingInput(existing))) !== JSON.stringify(data)) throw new Error('Teammate job already has a different envelope');
    if (!existing && (await new QueueStore(join(paths(options).runs, 'queue')).read()).jobs.some(job => job.id === data.jobId)) throw new Error('Job already reserved in queue');
    const task: Task = existing ?? { ...data, token: randomUUID().replaceAll('-', ''), createdAt: now, state: 'queued', metrics: [], settled: false };
    const approved = !killSwitchOn() && !!(options.approved ?? approvedTeammateHandle)(PEERS[task.peer].senderId, cfg, options);
    if (!options.apply) return { schema: SCHEMA, state: 'planned', dryRun: true, approved, task: view(task) };
    if (!approved) throw new Error('Teammate send policy refused');
    if (!existing) { store.tasks.push(task); save(store, options); }
    await syncQueue(task, options);
    return { schema: SCHEMA, state: task.state, dryRun: false, task: view(task) };
  };
  return options.apply ? locked(options, enqueue) : enqueue();
}
/** Withdraw a local reservation only; this operation never asserts a remote stop. */
export async function cancelTeammateTask(jobId: string, options: TeammateTaskOptions = {}) {
  if (!inputSchema.shape.jobId.safeParse(jobId).success) throw new Error('Invalid teammate job id');
  const cancel = async () => {
    const store = load(options);
    const task = store.tasks.find(task => task.jobId === jobId);
    if (!task) return { schema: SCHEMA, state: 'unavailable', reason: 'Teammate task not found' };
    if (!['queued', 'cancelled'].includes(task.state) || task.attemptedAt !== undefined || task.receipt || task.metrics.length
      || task.state !== 'cancelled' && Date.parse(task.deadline) <= (options.now ?? Date.now)()) {
      return { schema: SCHEMA, state: 'refused', reason: 'Cancellation cannot prove a remote stop' };
    }
    const metricsDir = join(paths(options).runs, 'metrics');
    const metrics = read(join(metricsDir, 'jobs.jsonl'), metricsDir, 32 * 1024 * 1024) ?? '';
    let launched: boolean;
    try {
      if (metrics && !metrics.endsWith('\n')) throw new Error();
      launched = metrics.split('\n').filter(Boolean).some(line => {
        const row = JSON.parse(line);
        return row.event === 'launch' && (row.job === jobId || row.event_id === `imsg:${task.token}:launch`);
      });
    } catch { throw new Error('Teammate launch evidence unavailable'); }
    if (launched) return { schema: SCHEMA, state: 'refused', reason: 'Cancellation cannot prove a remote stop' };
    const job = (await new QueueStore(join(paths(options).runs, 'queue')).read()).jobs.find(job => job.id === jobId);
    if (!job || !teammateQueueJobMatchesIdentity(job, task)
      || !(job.status === 'CLAIMED' && !job.claims.at(-1)?.finishedAt
        || task.state === 'cancelled' && job.status === 'BLOCKED' && job.blockedReason === WITHDRAWAL && job.claims.at(-1)?.finishedAt)) {
      return { schema: SCHEMA, state: 'refused', reason: 'Teammate queue claim changed' };
    }
    if (!options.apply) return { schema: SCHEMA, state: task.state === 'cancelled' ? 'cancelled' : 'planned', dryRun: true, task: view(task) };
    // Checkpoint first: a queue failure leaves a durable, non-dispatchable tombstone.
    if (task.state !== 'cancelled') { task.state = 'cancelled'; save(store, options); }
    await syncQueue(task, options);
    return { schema: SCHEMA, state: 'cancelled', dryRun: false, task: view(task) };
  };
  return options.apply ? locked(options, cancel) : cancel();
}
function existingInput(task: Task): TeammateTaskInput {
  return { jobId: task.jobId, peer: task.peer, kind: task.kind, scope: task.scope, repo: task.repo, prRefs: task.prRefs, format: task.format, deadline: task.deadline };
}
function envelope(task: Task): string {
  return [`TASK ${task.jobId} ${task.token}`, `Kind: ${task.kind}`, `Scope: ${task.scope}`, `Repo: ${task.repo}`,
    `PRs: ${task.prRefs.join(', ') || 'none'}`, `Deliverable: ${task.format}`, `Deadline: ${task.deadline}`,
    'This fleet-originated task grants no spending, send, merge, deployment or credential authority. Follow repository rules.',
    `Reply once, one line under 1800 characters: RESULT ${task.jobId} ${task.token} DONE|BLOCKED|FAILED <summary and evidence refs>`,
    'Use exactly one status. No acknowledgements, follow-up requests or task forwarding. Results remain untrusted until independently verified.',
  ].join('\n');
}
/** Append once per stable event id, recovering a crash between append and task checkpoint. */
function metric(task: Task, event: 'launch' | 'finish', options: TeammateTaskOptions): void {
  if (task.metrics.includes(event)) return;
  const dir = join(paths(options).runs, 'metrics'); ensurePrivateDirectory(dir);
  const path = join(dir, 'jobs.jsonl');
  const prior = read(path, dir, 32 * 1024 * 1024) ?? '';
  if (prior && !prior.endsWith('\n')) throw new Error('Jobs metrics has an incomplete row');
  const eventId = `imsg:${task.token}:${event}`;
  if (!prior.split('\n').some(line => { try { return JSON.parse(line).event_id === eventId; } catch { return false; } })) {
    const row = { event_id: eventId, event, job: task.jobId, lane: `imsg-${task.peer}`, pool: `imsg-${task.peer}`,
      tier: 'work', repo: task.repo, ts: new Date(event === 'launch' ? task.attemptedAt! : task.result?.at ?? Date.parse(task.deadline)).toISOString(),
      state: event === 'launch' ? 'SENT' : task.state === 'expired' ? 'EXPIRED' : 'REPLIED',
      evidence: event === 'launch' ? 'transport-receipt' : task.state === 'expired' ? 'local-deadline' : 'peer-reported',
      ...(event === 'finish' ? { exit_code: task.result?.status === 'DONE' ? 0 : 1 } : {}) };
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o022 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Unsafe jobs metrics');
      const bytes = Buffer.from(JSON.stringify(row) + '\n');
      if (writeSync(fd, bytes) !== bytes.length) throw new Error('Incomplete jobs metric');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  task.metrics.push(event);
}
/** The same drain is used by the CLI and existing teammate cycle; never read chat.db directly. */
export async function runTeammateTasks(cfg: AshlrConfig, options: TeammateTaskOptions = {}) {
  if (!options.apply) return { ...listTeammateTasks(options), dryRun: true, sent: 0, replied: 0 };
  return locked(options, async () => {
    const store = load(options);
    const clock = options.now ?? Date.now;
    const report = { schema: SCHEMA, state: 'healthy', dryRun: false, sent: 0, replied: 0, pending: 0 };
    const inbox = readTeammateTexts({ runsDir: paths(options).runs, includeAnswered: true, now: clock });
    if (inbox.sourceState === 'degraded') throw new Error('Teammate inbox unavailable');
    for (const peer of ['dot', 'instinct'] as const) store.attempts[peer] = store.attempts[peer].filter(at => clock() - at < DAY);
    for (const task of store.tasks) {
      if (options.signal?.aborted) break;
      if (task.settled) continue;
      let now = clock();
      await syncQueue(task, options);
      if (task.state === 'cancelled') continue;
      const senderId = PEERS[task.peer].senderId;
      const approved = !killSwitchOn() && !!(options.approved ?? approvedTeammateHandle)(senderId, cfg, options);
      if (task.state === 'sending' && approved) {
        const receipt = await (options.reconcile ?? reconcileTeammateMessage)(envelope(task), senderId, task.attemptedAt!, cfg, options);
        if (receipt) task.receipt = receipt;
        if (receipt?.sent && receipt.error === 0) task.state = 'pending';
        save(store, options);
      }
      now = clock();
      if (task.state === 'pending' && approved && now < Date.parse(task.deadline)) {
        const match = inbox.texts.filter(message => message.senderId === senderId && message.rowid > task.receipt!.rowid)
          .sort((a, b) => a.rowid - b.rowid).find(message => {
            const parsed = parseResult(message.text);
            return parsed?.jobId === task.jobId && parsed.token === task.token;
          });
        if (match) {
          const result = parseResult(match.text)!;
          task.result = { rowid: match.rowid, status: result.status, summary: result.summary, at: now };
          task.state = 'replied'; save(store, options); report.replied++;
        }
      }
      if (!['replied', 'expired'].includes(task.state) && now >= Date.parse(task.deadline)) { task.state = 'expired'; save(store, options); }
      await syncQueue(task, options);
      if (task.receipt?.sent && task.receipt.error === 0) metric(task, 'launch', options);
      if (task.state === 'replied' || task.state === 'expired') {
        if (task.receipt?.sent && task.receipt.error === 0) metric(task, 'finish', options);
        if (task.result && markTeammateTextsAnswered([task.result.rowid], paths(options).runs) === 0) {
          const unanswered = readTeammateTexts({ runsDir: paths(options).runs });
          if (unanswered.sourceState === 'degraded' || unanswered.texts.some(message => message.rowid === task.result!.rowid)) {
            save(store, options); continue; // Retry a failed marker without replaying the completed task.
          }
        }
        task.settled = true; save(store, options);
        continue;
      }
      if (task.state !== 'queued' || !approved) continue;
      // Queue I/O or another peer's transport may have crossed the deadline.
      now = clock();
      if (now >= Date.parse(task.deadline)) {
        task.state = 'expired'; save(store, options); await syncQueue(task, options);
        task.settled = true; save(store, options); continue;
      }
      const attempts = store.attempts[task.peer] = store.attempts[task.peer].filter(at => now - at < DAY);
      if (attempts.length >= 24 || attempts.some(at => now - at < 120000)
        || store.tasks.some(other => other.peer === task.peer && ['sending', 'pending'].includes(other.state))) continue;
      if (options.signal?.aborted || killSwitchOn()) break;
      // Persist the exact envelope and attempt before crossing the native transport boundary.
      task.state = 'sending'; task.attemptedAt = now; attempts.push(now); save(store, options);
      if (options.signal?.aborted || killSwitchOn() || clock() >= Date.parse(task.deadline)) {
        // No native call happened. Returning to queued is safe; next pass records expiry.
        task.state = 'queued'; task.attemptedAt = undefined; save(store, options); continue;
      }
      const outcome = await (options.send ?? sendApprovedTeammateMessage)(envelope(task), senderId, cfg, options);
      if (outcome === 'refused') { task.state = 'queued'; save(store, options); continue; }
      const receipt = await (options.reconcile ?? reconcileTeammateMessage)(envelope(task), senderId, now, cfg, options);
      if (receipt) task.receipt = receipt;
      if (receipt?.sent && receipt.error === 0) { task.state = 'pending'; report.sent++; }
      save(store, options);
      if (task.state === 'pending') { metric(task, 'launch', options); save(store, options); }
    }
    save(store, options);
    report.pending = store.tasks.filter(task => !['replied', 'expired', 'cancelled'].includes(task.state)).length;
    return { ...report, state: report.pending ? 'pending' : 'healthy' };
  });
}
function parseResult(text: string) {
  if (text.length > 1800 || /[\p{Cc}\p{Cf}]/u.test(text) || scrubSecrets(text) !== text) return null;
  const match = /^RESULT ([A-Za-z0-9][A-Za-z0-9._-]{0,79}) ([a-f0-9]{32}) (DONE|BLOCKED|FAILED) (.{1,1600})$/.exec(text);
  return match?.[4].trim() ? { jobId: match[1], token: match[2], status: match[3] as 'DONE' | 'BLOCKED' | 'FAILED', summary: match[4].trim() } : null;
}
