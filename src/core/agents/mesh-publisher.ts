/** Local metadata only; readers stay side-effect free. No message content or transport. */
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { desktopSessions, type DesktopSessionsResult } from '../desktop/desktop-sessions.js';
import { readFleetBoard } from '../fleet/coordination.js';
import { listTeammateTasks } from '../comms/imessage-teammate-tasks.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { listCoordination } from './claim-store.js';
import { readAgentRegistry, resolveAgent } from './bus-identity.js';
import { providerSchema } from './bus-v2-schema.js';
import { localWriteGate } from './send-gate.js';
import { publishMeshObservation, readAgentMesh, MESH_FRESH_MS, type MeshObservation } from './mesh.js';

type Claim = { agent: string; task: string; seen: number | null; until: number };
export interface MeshPublisherOptions {
  root?: string; runsDir?: string; now?: () => number; signal?: AbortSignal;
  desktop?: () => Promise<DesktopSessionsResult>;
  claims?: () => Claim[];
  teammates?: typeof listTeammateTasks;
  loopSeen?: () => number | null;
}
const PROVIDERS: Record<string, MeshObservation['provider']> = {
  codex: 'codex-personal', cursor: 'cursor-cloud', grok: 'grokbot', zai: 'glm',
  'codex-local': 'local', omlx: 'local', ollama: 'local', 'claude-api': 'claude', 'devin-flash': 'devin',
};
const provider = (lane: string) => providerSchema.safeParse(lane).data ?? PROVIDERS[lane] ?? null;
const millis = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const taskText = (tasks: string[]) => [...new Set(tasks)].sort().join(', ').slice(0, 1024) || null;

export async function publishAgentMesh(options: MeshPublisherOptions = {}) {
  if (options.signal?.aborted || localWriteGate()) return { status: 'held', published: 0, failed: 0 };
  const now = (options.now ?? Date.now)(), runs = options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const fixed = { root: options.root, now: () => now };
  const before = readAgentMesh(fixed), rows: MeshObservation[] = [], sources: Record<string, boolean> = {};
  const add = (source: MeshObservation['source'], agent: string, lane: string, lastSeen: number | null,
    currentTask: string | null, status: MeshObservation['status'], expiresAt: number | null = null) => {
    rows.push({ source, agent, displayName: agent, lane, provider: provider(lane), lastSeen, currentTask, status, expiresAt });
  };
  try {
    const claims = options.claims ? options.claims() : (() => {
      const coordinated = listCoordination(options.root, now);
      const board = readFleetBoard({ ...(options.root ? { path: join(options.root, 'coordination.jsonl') } : {}), now, reap: false });
      if (coordinated.source !== 'available' && board.state === 'unknown') throw new Error('claims unavailable');
      return [...coordinated.claims.filter(c => c.live).map(c => ({
        agent: c.owner, task: c.key, seen: millis(c.started), until: c.leaseUntil,
      })), ...board.claims.map(c => ({ agent: c.agent, task: c.task, seen: c.claimedAt, until: c.expiresAt }))];
    })();
    for (const agent of new Set(claims.map(c => c.agent))) {
      const live = claims.filter(c => c.agent === agent && c.until > now);
      if (!live.length) continue;
      const times = live.flatMap(c => c.seen === null ? [] : [c.seen]);
      add('cli', agent, agent, times.length ? Math.max(...times) : null, taskText(live.map(c => c.task)),
        'active', Math.min(...live.map(c => c.until)));
    }
    sources.cli = true;
  } catch { sources.cli = false; }
  let desktopDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const desktop = await Promise.race([
      (options.desktop ?? desktopSessions)(),
      new Promise<DesktopSessionsResult>((_, reject) => {
        desktopDeadline = setTimeout(() => reject(new Error('desktop timeout')), 5000);
      }),
    ]);
    if (!desktop.ok) throw new Error('desktop unavailable');
    for (const session of desktop.sessions) {
      const app = session.rosterApp;
      if (!app || app === 'phantom') continue;
      const key = createHash('sha256').update(JSON.stringify([app, session.windowTitle])).digest('hex').slice(0, 12);
      add('desktop', 'desktop-' + app + '-' + key, app, now, session.sessionTitle, 'active');
    }
    sources.desktop = true;
  } catch { sources.desktop = false; }
  finally { clearTimeout(desktopDeadline); }
  try {
    const tasks = (options.teammates ?? listTeammateTasks)({ runsDir: runs, now: () => now }).tasks;
    const loopSeen = options.loopSeen ?? (() => {
      const dir = join(runs, 'imessage');
      const read = readStableRegularFile(join(dir, 'teammate-status.json'), { anchorPath: dir, maxFileBytes: 65536, remainingBytes: 65536 });
      return read.ok ? millis((JSON.parse(read.text) as { at: string }).at) : null;
    });
    const at = loopSeen(), fresh = at !== null && at <= now && now - at < MESH_FRESH_MS;
    for (const peer of ['dot', 'instinct'] as const) {
      const own = tasks.filter(t => t.peer === peer);
      const seen = own.flatMap(t => t.result && t.result.at <= now ? [t.result.at] : []);
      add('imessage', 'imsg-' + peer, peer === 'dot' ? 'openai-dot' : 'imessage',
        seen.length ? Math.max(...seen) : null,
        fresh ? taskText(own.filter(t => ['queued', 'sending', 'pending'].includes(t.state) && Date.parse(t.deadline) > now).map(t => t.jobId)) : null,
        'unknown');
    }
    sources.imessage = fresh;
  } catch { sources.imessage = false; }
  const registry = readAgentRegistry(fixed);
  if (registry.status === 'ok') for (const row of rows) {
    row.agent = resolveAgent(registry.registry, row.agent)?.handle ?? row.agent;
  }
  // A source failure is not an observation that its agents have gone offline.
  for (const previous of before.agents) {
    if (previous.source === 'registry' || rows.some(row => row.agent === previous.agent)) continue;
    const { address: _address, observedAt: _observedAt, ...row } = previous;
    rows.push({ ...row, source: previous.source, currentTask: null, expiresAt: null,
      status: sources[previous.source] ? 'offline' : 'unknown' });
  }
  let published = 0, failed = 0;
  for (const row of rows) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (options.signal?.aborted) break;
    const result = publishMeshObservation(row, fixed);
    if (result.status === 'posted' || result.status === 'duplicate') published++; else failed++;
  }
  return { status: options.signal?.aborted || failed || Object.values(sources).some(ok => !ok) ? 'partial' : 'ok', published, failed, sources };
}

/** One bounded, non-overlapping sample per minute. Stop also cancels pending publication. */
export function scheduleAgentMesh(sample = publishAgentMesh): (() => void) | null {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return null;
  let stopped = false, timer: ReturnType<typeof setTimeout>, controller: AbortController;
  const tick = async () => {
    controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30_000);
    try { await sample({ signal: controller.signal }); } catch { /* retry next sample */ }
    finally {
      clearTimeout(deadline);
      if (!stopped) { timer = setTimeout(() => { void tick(); }, 60_000); timer.unref(); }
    }
  };
  timer = setTimeout(() => { void tick(); }, 0); timer.unref();
  return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
}
