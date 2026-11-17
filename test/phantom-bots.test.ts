import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parsePhantomBot, planPhantomBot, writePhantomBot, readPhantomBot, listPhantomBots, explainPhantomBot } from '../src/core/agents/phantom-bot.js';
import { runBotsCli } from '../src/cli/bots.js';

const homes: string[] = [];
async function home() { const dir = await mkdtemp(join(tmpdir(), 'bots-')); homes.push(dir); return dir; }
afterEach(async () => { await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const bot = () => ({ schema: 'phantom-bot.v1', id: 'helper', outcome: 'Review changes', repos: [], triggers: [],
  lanePolicy: { needs: ['code'], min_tier: 'fast', max_tier: 'work', max_cost_class: 'included' },
  memory: { pointer: 'memory.md' }, channels: [], needsYou: [], profile: 'helper' });
it('validates neutral policy and rejects invalid tiers, capabilities and vendor fields', () => {
  expect(parsePhantomBot(bot()).id).toBe('helper');
  for (const field of ['lane', 'lanes', 'pool', 'engine', 'provider', 'preferred_lane', 'fallback', 'work_class']) {
    expect(() => parsePhantomBot({ ...bot(), lanePolicy: { ...bot().lanePolicy, [field]: 'vendor' } })).toThrow();
  }
  for (const policy of [{ min_tier: 'frontier' }, { needs: ['bad need'] }, { max_cost_class: 'free' }, { max_cost_class: 'metered' }]) {
    expect(() => parsePhantomBot({ ...bot(), lanePolicy: { ...bot().lanePolicy, ...policy } })).toThrow();
  }
  expect(() => parsePhantomBot({ ...bot(), id: '../escape' })).toThrow();
  const policy = { needs: [], min_tier: 'fast', max_tier: 'work' };
  expect(parsePhantomBot({ ...bot(), lanePolicy: policy }).lanePolicy.max_cost_class).toBe('included');
});
it('plans without writing, stores, lists, reads, and refuses existing ids', async () => {
  const dir = await home();
  expect(await listPhantomBots(dir)).toEqual([]);
  expect((await planPhantomBot(bot(), dir)).paths).toEqual([join(dir, '.phantom/bots/helper/bot.json')]);
  expect(await readdir(dir)).toEqual([]);
  const record = await writePhantomBot(bot(), dir);
  expect(await readPhantomBot('helper', dir)).toEqual(record);
  expect(await listPhantomBots(dir)).toEqual([record]);
  await expect(planPhantomBot(bot(), dir)).rejects.toThrow('already exists');
  await expect(readPhantomBot('missing', dir)).rejects.toThrow();
});
it('CLI refuses live create and dry-run writes nothing', async () => {
  const dir = await home(), output: string[] = [];
  const args = ['create', '--id', 'helper', '--outcome', 'Review changes', '--profile', 'helper', '--json'];
  expect(await runBotsCli(args, line => output.push(line), dir)).toBe(1);
  expect(output[0]).toContain('Live bot creation disabled');
  expect(await runBotsCli([...args, '--dry-run'], line => output.push(line), dir)).toBe(0);
  expect(JSON.parse(output[1]).record.schema).toBe('phantom-bot.v1');
  expect(await readdir(dir)).toEqual([]);
});
it('explains exhausted failover, reset preference, unknown evidence and no capable lanes read-only', async () => {
  const dir = await home(), now = Date.parse('2026-11-18T12:00:00Z');
  await mkdir(join(dir, 'queue'));
  const put = (file: string, value: unknown) => writeFile(join(dir, file), JSON.stringify(value));
  const lanes = ['first', 'next', 'third', 'codex-local'];
  await put('models.json', Object.fromEntries(lanes.map(lane => [lane, 'custom-model'])));
  const slots = Object.fromEntries(lanes.map(lane => [lane, { target: 1, hard_cap: 1, capabilities: ['code'], tiers: ['fast'],
    cost_class: lane === 'codex-local' ? 'local' : 'included' }]));
  await put('queue/slots.json', slots);
  await put('queue/admission.json', { admit: true });
  await put('queue/route-request.json', { task_class: 'bug-fix', repo: 'bot', tier_hint: 'fast', lane_candidates: lanes,
    fallback: [{ lane: 'codex-local', on: ['quota'] }],
    quota_state: Object.fromEntries(lanes.map(lane => [lane, 'available'])), machine_state: { admit: true, running_by_lane: Object.fromEntries(lanes.map(lane => [lane, 0])) } });
  const capacity = Object.fromEntries(lanes.map((lane, i) => [lane, { resetAt: new Date(now + (i + 1) * 3600000).toISOString(), remainingPercent: i === 0 ? 0 : 50, observedAt: new Date(now).toISOString() }]));
  await put('queue/route-capacity.json', capacity);
  const record = parsePhantomBot(bot());
  let report = await explainPhantomBot(record, dir, now);
  expect(report.routing.decision).toMatchObject({ lane: 'next' });
  expect(report.routing.rejected).toContainEqual({ lane: 'first', reason_codes: ['capacity_exhausted'] });
  expect(report.routing.rejected).toContainEqual({ lane: 'codex-local', reason_codes: ['local_opt_in_required'] });
  expect(report.routing.fallback.lanes.map(row => row.lane)).toEqual(['third']);
  capacity.first.remainingPercent = 20;
  await put('queue/route-capacity.json', capacity);
  expect((await explainPhantomBot(record, dir, now)).routing.decision).toMatchObject({ lane: 'first' });
  capacity.first.resetAt = new Date(now - 1).toISOString();
  capacity.next.remainingPercent = 0;
  await put('queue/route-capacity.json', capacity);
  report = await explainPhantomBot(record, dir, now);
  expect(report.routing.decision).toMatchObject({ lane: 'third' });
  expect(report.routing.rejected.find(row => row.lane === 'first')?.reason_codes).toContain('capacity_exhausted');
  expect((await explainPhantomBot(record, dir, now + 16 * 60000)).routing.decision).toMatchObject({ lane: null });
  record.lanePolicy.needs = ['browser'];
  report = await explainPhantomBot(record, dir, now);
  expect(report.routing.decision).toMatchObject({ lane: null, reason_codes: ['no-candidates'] });
  expect(report.routing.rejected.every(row => row.reason_codes.includes('missing_capability'))).toBe(true);
  record.lanePolicy.needs = ['code'];
  await put('queue/slots.json', Object.fromEntries(lanes.map(lane => [lane, { target: 1, hard_cap: 1 }])));
  report = await explainPhantomBot(record, dir, now);
  expect(report.routing.rejected[0].reason_codes).toEqual(expect.arrayContaining(['missing_capability', 'cost_class_unknown', 'tier_unknown']));
  expect(await readdir(dir)).toEqual(['models.json', 'queue']);
  expect((await explainPhantomBot(record, await home(), now)).routing.decision).toMatchObject({ lane: null });
});
