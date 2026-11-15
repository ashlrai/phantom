import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobView, NodeView } from './index.js';
import { NODE_OFFLINE_MS } from './router.js';
import { validId } from './state.js';

/** Fixed, read-only recipes. Queue records never supply commands, paths or credentials. */
export const LIGHT_RECIPES = [
  { id: 'channels-status', requires: ['light', 'comms'], args: ['channels', 'status', '--json'] },
  { id: 'comms-status', requires: ['light', 'comms'], args: ['comms', 'status', '--json'] },
  { id: 'docs-check', requires: ['light'], args: null },
] as const;
const PREFIX = 'muse-light-';
const packOf = (id: string) => `muse-light:${id}:v1`;
export function lightRecipe(job: JobView) {
  if (!job || !Array.isArray(job.requires) || !Array.isArray(job.secrets)) return undefined;
  return LIGHT_RECIPES.find(r => job.owner === 'ashlr' && job.pack === packOf(r.id) &&
    validId(job.id) && new RegExp(`^${PREFIX}${r.id}-[0-9]+$`).test(job.id) && job.secrets.length === 0 &&
    job.requires.length === r.requires.length && r.requires.every(c => job.requires.includes(c)));
}
export interface LightView { nodes: NodeView[]; jobs: JobView[] }
export type NodeCall = (verb: string, args: string[]) => Record<string, unknown>;

/** Called by restock independently of ready.tsv. Repeated passes reuse hourly IDs. */
export function restockLight(call: NodeCall, apply: boolean, now = Date.now()) {
  const view = call('status', ['--owner', 'ashlr']) as unknown as LightView;
  const jobs = view.jobs.filter(j => lightRecipe(j));
  const outstanding = jobs.filter(j => j.state !== 'completed').length;
  const muse = view.nodes.find(n => n.nodeId === 'muse' && n.owners.includes('ashlr'));
  const ready = !!muse && muse.live && muse.expiresAt > now && muse.heartbeatAt > 0 &&
    muse.heartbeatAt <= now && now - muse.heartbeatAt < NODE_OFFLINE_MS &&
    muse.slots === 2 && muse.usage < 900 && muse.caps.includes('light');
  const candidates = LIGHT_RECIPES.filter(r => r.requires.every(c => muse?.caps.includes(c)))
    .map(r => ({ jobId: `${PREFIX}${r.id}-${Math.floor(now / 3_600_000)}`, recipe: r }))
    .filter(c => !view.jobs.some(j => j.id === c.jobId)).slice(0, ready ? Math.max(0, 2 - outstanding) : 0);
  let enqueued = 0;
  if (apply) for (const c of candidates) {
    if (call('enqueue', ['--job', c.jobId, '--owner', 'ashlr', '--requires', c.recipe.requires.join(','),
      '--pack', packOf(c.recipe.id)])['enqueued'] === true) enqueued++;
  }
  const completed = jobs.filter(j => j.state === 'completed');
  return { schema: 'muse.light.v1', observedAt: now, apply, ready, outstanding, enqueued,
    planned: candidates.map(c => c.jobId), completed: completed.length,
    museCompleted: completed.filter(j => j.completedBy === 'muse').length,
    completions: completed.slice(-20).map(j => ({ jobId: j.id, pack: j.pack, nodeId: j.completedBy ?? null })) };
}

/** Trusted runner entry point. Output is an opaque reference, never command output. */
export async function runLightJob(input: AsyncIterable<Buffer | string>, run: typeof spawnSync = spawnSync) {
  let text = '';
  for await (const chunk of input) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 16_384) throw new Error('Light runner input too large');
  }
  const request = JSON.parse(text) as { protocol: string; job: JobView; claim: { jobId: string; token: number } };
  const recipe = request.protocol === 'phm-node-worker/v1' && lightRecipe(request.job);
  if (!recipe || request.claim.jobId !== request.job.id || !Number.isSafeInteger(request.claim.token) || request.claim.token < 1)
    throw new Error('Unsupported light job');
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const args = recipe.args ? [resolve(root, 'bin/ashlr'), ...recipe.args] : [resolve(root, 'scripts/check-documentation.mjs')];
  const result = run(process.execPath, ['--max-old-space-size=256', ...args], { cwd: root, timeout: 120_000, killSignal: 'SIGKILL',
    stdio: 'ignore', env: { PATH: process.env['PATH'], HOME: homedir() } });
  if (result.error || result.status !== 0) throw new Error('Light check failed');
  return { resultRef: `light:${recipe.id}:${request.claim.token}` };
}
