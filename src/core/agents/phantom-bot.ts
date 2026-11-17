import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BOT_ID_PATTERN } from './bot-templates.js';
import { CHANNEL_IDS } from './channel-policy.js';
import { validateQueue } from '../queue/schema.js';
import { assertMetadata } from '../connectors/profile.js';
import { loadRouteSources, enumerateRouteCandidates, rankRouteCandidates, routeCandidateRejections } from '../routing/decision-candidates.js';
import { routeRequestSchema } from '../routing/decision-schema.js';
import { decideRoute } from '../routing/decision.js';
import { postureEvidence } from '../queue/route-explain.js';

const id = z.string().regex(BOT_ID_PATTERN);
const text = z.string().trim().min(1).max(4096);
const tier = z.enum(['frontier', 'work', 'mid', 'fast']);
export const phantomBotSchema = z.object({
  schema: z.literal('phantom-bot.v1'), id, outcome: text, repos: z.array(text),
  triggers: z.array(z.object({ kind: z.enum(['schedule', 'event']), automationId: text.optional(), spec: text.optional() }).strict()
    .refine(value => !!(value.automationId || value.spec), 'Trigger needs automationId or spec.')),
  lanePolicy: z.object({ needs: z.array(text), min_tier: tier, max_tier: tier,
    max_cost_class: z.enum(['local', 'included', 'metered']), data_class: z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
    work_class: z.enum(['bulk', 'standard', 'judgment']).optional() }).strict(),
  memory: z.object({ pointer: text }).strict(), channels: z.array(z.enum(CHANNEL_IDS)),
  needsYou: z.array(z.object({ id: text, kind: z.enum(['decision', 'review-pr', 'merge-pr', 'permission', 'report', 'fyi']), title: text, createdAt: z.string().datetime() }).strict()),
  profile: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/),
}).strict();
export type PhantomBot = z.infer<typeof phantomBotSchema>;
export function parsePhantomBot(value: unknown): PhantomBot {
  assertMetadata(JSON.stringify(value));
  const bot = phantomBotSchema.parse(value);
  validateQueue({ schema: 'queue.v1', jobs: [{ ...bot.lanePolicy, id: bot.id, status: 'READY', priority: 'P2',
    tier: bot.lanePolicy.min_tier, repo: 'bot', scope: bot.outcome, acceptance: '', deps: [], claims: [] }] });
  return bot;
}
const root = (home: string) => join(home, '.phantom', 'bots');
async function botPath(name: string, home: string): Promise<string> {
  id.parse(name);
  for (const path of [join(home, '.phantom'), root(home), join(root(home), name)]) {
    try { if (!(await lstat(path)).isDirectory()) throw new Error('Unsafe bot directory.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return join(root(home), name, 'bot.json');
}
export async function readPhantomBot(name: string, home = homedir()): Promise<PhantomBot> {
  const path = await botPath(name, home);
  const info = await lstat(path);
  if (!info.isFile() || info.size > 262144) throw new Error('Invalid bot file.');
  const bot = parsePhantomBot(JSON.parse(await readFile(path, 'utf8')));
  if (bot.id !== name) throw new Error('Bot id mismatch.');
  return bot;
}
export async function listPhantomBots(home = homedir()): Promise<PhantomBot[]> {
  await botPath('probe', home);
  let names: string[];
  try { names = await readdir(root(home)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const bots: PhantomBot[] = [];
  for (const name of names.filter(name => BOT_ID_PATTERN.test(name)).sort()) {
    try { bots.push(await readPhantomBot(name, home)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return bots;
}
export async function planPhantomBot(value: unknown, home = homedir()): Promise<{ record: PhantomBot; paths: string[] }> {
  const record = parsePhantomBot(value);
  const path = await botPath(record.id, home);
  try { await lstat(join(root(home), record.id)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { record, paths: [path] };
    throw error;
  }
  throw new Error('Bot id already exists.');
}
export async function writePhantomBot(value: unknown, home = homedir()): Promise<PhantomBot> {
  const plan = await planPhantomBot(value, home);
  await mkdir(root(home), { recursive: true, mode: 0o700 });
  await mkdir(join(root(home), plan.record.id), { mode: 0o700 });
  await writeFile(plan.paths[0]!, JSON.stringify(plan.record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return plan.record;
}
export async function explainPhantomBot(bot: PhantomBot, runs = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), now = Date.now()) {
  parsePhantomBot(bot);
  const sources = await loadRouteSources(runs);
  const saved = routeRequestSchema.safeParse(sources.request);
  const { min_tier, max_tier, ...requirements } = bot.lanePolicy;
  const request = routeRequestSchema.parse({ ...(saved.success ? saved.data : {
    task_class: 'bug-fix', repo: 'bot', lane_candidates: [], quota_state: {}, machine_state: { admit: false, running_by_lane: {} },
  }), ...requirements, tier_hint: min_tier, mode: undefined });
  const candidates = enumerateRouteCandidates(request, sources);
  const ranked = rankRouteCandidates(request, candidates, now);
  const decision = await decideRoute(request, sources, { backends: [], nowMs: now });
  const alternatives = request.lane_candidates.map(lane => {
    const candidate = candidates.find(candidate => candidate.lane === lane);
    const rank = ranked.findIndex(candidate => candidate.lane === lane);
    return { lane, rank: rank < 0 ? null : rank + 1, reasons: candidate
      ? routeCandidateRejections(request, candidate, now).concat(rank < 0 ? ['tier or capacity unavailable'] : ['ranked by reset pressure, cost and policy priors'])
      : [request.quota_state[lane] === 'exhausted' ? 'quota exhausted' : 'admission, quota, slots, model or capacity evidence unavailable'] };
  });
  return { record: bot, routing: { decision, alternatives, tierCeiling: max_tier, posture: await postureEvidence(runs),
    interpretation: 'Spend remaining quota before an upcoming reset; reject exhausted, expired, stale or unknown capacity. Advisory only.' }, primitives: {
    schema: 'phantom-bot.v1 metadata', id: 'bot-templates BOT_ID_PATTERN / ~/.phantom/bots',
    outcome: 'agent profile instructions', repos: 'enrollment (no grant implied)',
    profile: 'agent-profile.ts versioned profile reference', triggers: 'automations store; not live: next step',
    lanePolicy: 'queue.v1 capability/tier/cost requirements; no preferred lane', memory: 'skills/memory pointer (not read)',
    channels: 'channel-policy.ts / owner thread (no send)', needsYou: 'needs-you attention metadata (no approval implied)',
  } };
}
