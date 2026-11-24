import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './helpers/local-memory.js';
import { localModelFit, memoryFit } from '../src/core/resources/local-memory-fit.js';
import { cmdSubagent } from '../src/cli/subagent.js';
import { listSubagents, planSubagentSpawn, readSubagentRecord, subagentRecordSchema, writeSubagentRecord, type SubagentOptions, type SubagentSpawnInput } from '../src/core/subagent/spawn.js';
import { readSubagentResult, recordSubagentResult } from '../src/core/subagent/result.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const input: SubagentSpawnInput = { parent_id: 'job:root', tier: 'fast', task: 'Review a bounded change' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'subagent-')); roots.push(root);
  const home = join(root, 'home'), runsRoot = join(root, 'runs');
  await mkdir(home); await mkdir(join(runsRoot, 'queue'), { recursive: true }); await mkdir(join(runsRoot, 'metrics'));
  const save = async (file: string, value: unknown) => writeFile(join(runsRoot, file), JSON.stringify(value));
  await save('models.json', { claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol', local: 'local-coder:small' });
  await save('queue/slots.json', Object.fromEntries(['claude', 'codex', 'local'].map(l => [l, { target: 2, hard_cap: 2 }])));
  await save('queue/admission.json', { admit: true });
  await save('queue/status.json', { schema: 'dispatchd.status.v1', lanes: { claude: { running: 0 }, codex: { running: 0 }, local: { running: 0 } } });
  await save('metrics/work-market.jsonl', { schema: 'work-market.v1', event: 'posture', lanes: Object.fromEntries(['claude', 'codex', 'local'].map(l => [l, { posture: 'balanced', posture_reason: 'fixture', cost_class: l === 'local' ? 'local' : 'included' }])) });
  const options: SubagentOptions = { home, runsRoot, kill: () => 'inactive', paused: () => false, nowMs: Date.parse('2026-11-17T12:00:00Z') };
  return { root, home, runsRoot, options, save };
}

describe('bounded cross-provider subagents', () => {
  it('routes provider-neutrally without writes or task content', async () => {
    const { options, home, runsRoot } = await fixture();
    const before = await readdir(join(runsRoot, 'queue'));
    const result = await planSubagentSpawn(input, options);
    expect(result).toMatchObject({ ok: true, dry_run: true, applied: false, record: { state: 'planned', lane: 'local', depth: 1, max_tokens: 16000 }, parent: { kind: 'root', depth: 0 } });
    expect(subagentRecordSchema.safeParse(result.record).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(input.task);
    expect(result.record.task_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readdir(home)).toEqual([]);
    expect(await readdir(join(runsRoot, 'queue'))).toEqual(before);
    expect(await listSubagents(input.parent_id, options)).toMatchObject({ count: 0, subagents: [] });
    expect(await readSubagentResult('sa-0000000000000000', options)).toMatchObject({ found: false, state: null });
  });

  it('holds applies without queue writes, lists children and caps depth', async () => {
    const { options, runsRoot, home } = await fixture();
    const queue = await readdir(join(runsRoot, 'queue'));
    const bytes = await Promise.all(queue.map(n => readFile(join(runsRoot, 'queue', n), 'utf8')));
    let parent_id = input.parent_id;
    for (let depth = 1; depth <= 3; depth++) {
      const result = await planSubagentSpawn({ ...input, parent_id, apply: true }, options);
      expect(result).toMatchObject({ ok: true, applied: false, record: { state: 'held', depth } });
      expect(result.reason_codes).toContain('apply-inert-no-scoped-live-path');
      expect((await listSubagents(parent_id, options)).subagents.map(r => r.id)).toEqual([result.record.id]);
      expect(await readSubagentResult(result.record.id, options)).toMatchObject({ found: true, state: 'held' });
      expect((await stat(join(home, '.ashlr/subagents', `${result.record.id}.json`))).mode & 0o777).toBe(0o600);
      parent_id = result.record.id;
    }
    expect((await stat(join(home, '.ashlr/subagents'))).mode & 0o777).toBe(0o700);
    const fourth = await planSubagentSpawn({ ...input, parent_id, apply: true }, options);
    expect(fourth).toMatchObject({ ok: false, record: { state: 'refused', depth: 4 } });
    expect(fourth.reason_codes).toContain('depth-exceeded');
    expect(await readSubagentRecord(fourth.record.id, options)).toBeNull();
    expect(await readdir(join(runsRoot, 'queue'))).toEqual(queue);
    expect(await Promise.all(queue.map(n => readFile(join(runsRoot, 'queue', n), 'utf8')))).toEqual(bytes);
  });

  it.each([
    [{ tools_allowed: ['web'] }, 'scope-tools-not-subset'],
    [{ tools_allowed: ['unknown'] }, 'tool-unknown'],
    [{ max_cost_class: 'metered' }, 'scope-cost-not-subset'],
    [{ max_tokens: 200001 }, 'scope-tokens-not-subset'],
    ...['/etc', '../src', 'src/../x', 'C:\\private', 'src\0x'].map(p => [{ write_scope: [p] }, 'write-scope-invalid']),
  ] as [Partial<SubagentSpawnInput>, string][])('refuses widening or invalid scope %j', async (change, reason) => {
    const { options } = await fixture();
    const result = await planSubagentSpawn({ ...input, ...change, apply: true }, options);
    expect(result.ok).toBe(false); expect(result.reason_codes).toContain(reason);
    expect(await readSubagentRecord(result.record.id, options)).toBeNull();
  });

  it('inherits and narrows parent paths, tokens, tools, cost and tier', async () => {
    const { options } = await fixture();
    const p = await planSubagentSpawn({ ...input, tier: 'mid', tools_allowed: ['read'], write_scope: ['src/**', 'test/'], max_tokens: 20000, max_cost_class: 'local', apply: true }, options);
    const child = { ...input, parent_id: p.record.id };
    expect((await planSubagentSpawn({ ...child, write_scope: ['src/./x/y', 'test/a.ts'] }, options))).toMatchObject({ ok: true, record: { max_tokens: 16000, max_cost_class: 'local', tools_allowed: ['read'], write_scope: ['src/x/y', 'test/a.ts'] } });
    for (const [change, reason] of [
      [{ tier: 'work' }, 'scope-tier-not-subset'], [{ tools_allowed: ['edit'] }, 'scope-tools-not-subset'],
      [{ write_scope: ['src2/a'] }, 'scope-write-not-subset'], [{ max_tokens: 20001 }, 'scope-tokens-not-subset'],
      [{ max_cost_class: 'included' }, 'scope-cost-not-subset'],
    ] as [Partial<SubagentSpawnInput>, string][]) expect((await planSubagentSpawn({ ...child, ...change }, options)).reason_codes).toContain(reason);
    expect((await planSubagentSpawn({ ...child, tools_allowed: [], write_scope: [] }, options)).ok).toBe(true);
  });

  it('refuses a local-only child when memory fit is unknown without widening its cost cap', async () => {
    const { options, home } = await fixture();
    vi.mocked(localModelFit).mockReturnValue(memoryFit('local-coder:small', null, 65536, null));
    const result = await planSubagentSpawn({ ...input, max_cost_class: 'local', apply: true }, options);
    expect(result).toMatchObject({ ok: false, applied: false, record: {
      state: 'refused', lane: null, max_cost_class: 'local',
    } });
    expect(result.reason_codes).toContain('no-eligible-lane-quota');
    expect(result.routing.decision?.local_models_refused).toEqual([
      expect.objectContaining({ verdict: 'unknown' }),
    ]);
    expect(await readdir(home)).toEqual([]);
    expect(await listSubagents(input.parent_id, options)).toMatchObject({ count: 0 });
  });

  it('never falls back to metered or unknown-cost lanes', async () => {
    const { options, save } = await fixture();
    await save('queue/slots.json', { claude: { target: 1, hard_cap: 1 } });
    await save('metrics/work-market.jsonl', { schema: 'work-market.v1', event: 'posture', lanes: { claude: { posture: 'balanced', posture_reason: 'fixture', cost_class: 'metered' } } });
    for (const removeEvidence of [false, true]) {
      if (removeEvidence) await save('metrics/work-market.jsonl', {});
      const result = await planSubagentSpawn(input, options);
      expect(result.reason_codes).toContain('no-eligible-lane-quota'); expect(result.record.lane).toBeNull();
      expect(result.routing.eligible_lanes).toEqual([]);
    }
  });

  it('rejects quota exhaustion, held slots, missing status, and admission blocks', async () => {
    const { options, save } = await fixture();
    await save('queue/slots.json', { local: { target: 1, hard_cap: 1 } });
    await save('queue/route-capacity.json', { local: { resetAt: null, remainingPercent: 0, costPerMTok: 0 } });
    expect((await planSubagentSpawn(input, options)).reason_codes).toContain('no-eligible-lane-quota');
    await save('queue/route-capacity.json', {});
    await save('queue/slots.json', { local: { target: 1, hard_cap: 1, held: true } });
    expect((await planSubagentSpawn(input, options)).ok).toBe(false);
    await save('queue/slots.json', { local: { target: 1, hard_cap: 1 } });
    await save('queue/status.json', { lanes: {} });
    expect((await planSubagentSpawn(input, options)).ok).toBe(false);
    await save('queue/admission.json', { admit: false });
    expect((await planSubagentSpawn(input, options)).reason_codes).toContain('admission-blocked');
  });

  it.each(['active', 'unknown'] as const)('refuses KILL %s and pause', async kill => {
    const { options } = await fixture();
    expect((await planSubagentSpawn(input, { ...options, kill: () => kill })).reason_codes).toContain('kill-engaged');
    expect((await planSubagentSpawn(input, { ...options, paused: () => true })).reason_codes).toContain('paused');
  });

  it('refuses a missing subagent parent without routing or persisting', async () => {
    const { options, home } = await fixture();
    const result = await planSubagentSpawn({ ...input, parent_id: 'sa-0000000000000000', tier: 'frontier', apply: true }, options);
    expect(result).toMatchObject({ ok: false, record: { state: 'refused' },
      reason_codes: ['parent-not-found'], routing: { decision: null, eligible_lanes: [], excluded_lanes: [] } });
    expect(await readdir(home)).toEqual([]);
  });

  it('refuses a completed subagent parent without routing or persisting', async () => {
    const { options } = await fixture();
    const parent = await planSubagentSpawn({ ...input, apply: true }, options);
    expect(await recordSubagentResult(parent.record.id, { state: 'completed', result_ref: 'run:parent' }, options)).toEqual({ ok: true, reason: null });
    const result = await planSubagentSpawn({ ...input, parent_id: parent.record.id, apply: true }, options);
    expect(result).toMatchObject({ ok: false, record: { state: 'refused' },
      reason_codes: ['parent-state-invalid'], routing: { decision: null, eligible_lanes: [], excluded_lanes: [] } });
    expect((await listSubagents(parent.record.id, options)).count).toBe(0);
    expect(await readSubagentRecord(result.record.id, options)).toBeNull();
  });

  it('validates result transitions and bounded references without storing content', async () => {
    const { options } = await fixture();
    const result = await planSubagentSpawn({ ...input, apply: true }, options), id = result.record.id;
    for (const result_ref of ['https://example.com', 'run:', `artifact:${'x'.repeat(201)}`, 'run:x\nsecret']) {
      expect(await recordSubagentResult(id, { state: 'completed', result_ref }, options)).toEqual({ ok: false, reason: 'result-ref-invalid' });
    }
    expect(await recordSubagentResult(id, { state: 'completed', result_ref: 'pr:owner/repo#123' }, options)).toEqual({ ok: true, reason: null });
    expect(await readSubagentResult(id, options)).toMatchObject({ found: true, state: 'completed', result_ref: 'pr:owner/repo#123' });
    expect(await recordSubagentResult(id, { state: 'failed', result_ref: 'run:1' }, options)).toEqual({ ok: false, reason: 'state-transition-invalid' });
    expect(await recordSubagentResult('sa-0000000000000000', { state: 'failed', result_ref: 'job:x' }, options)).toEqual({ ok: false, reason: 'not-found' });
    await writeSubagentRecord({ ...result.record, state: 'running' }, options);
    expect(await recordSubagentResult(id, { state: 'failed', result_ref: 'artifact:failure' }, options)).toEqual({ ok: true, reason: null });
  });

  it('ignores malformed, oversized, symlink and mismatched record files and sorts children', async () => {
    const { options, home } = await fixture();
    const a = await planSubagentSpawn({ ...input, apply: true }, options);
    const b = await planSubagentSpawn({ ...input, apply: true }, { ...options, nowMs: options.nowMs! - 1000 });
    const dir = join(home, '.ashlr/subagents');
    await writeFile(join(dir, 'sa-1111111111111111.json'), '{');
    await writeFile(join(dir, 'sa-2222222222222222.json'), ' '.repeat(1024 * 1024 + 1));
    await writeFile(join(dir, 'sa-3333333333333333.json'), JSON.stringify(a.record));
    await symlink(join(dir, `${a.record.id}.json`), join(dir, 'sa-4444444444444444.json'));
    expect((await listSubagents(input.parent_id, options)).subagents.map(r => r.id)).toEqual([b.record.id, a.record.id]);
    expect(await readSubagentRecord('../escape', options)).toBeNull();
  });

  it('parses CLI usage, routes, lists and reads results with injected roots', async () => {
    const { options } = await fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = ['spawn', '--parent', input.parent_id, '--tier', 'fast', '--task', input.task];
    for (const args of [[], ['unknown'], ['list'], ['list', '--parent', '../bad'], ['result'],
      [...base, '--dry-run', '--apply'], [...base, '--max-tokens', '-1'], [...base, '--max-tokens', '1.5'],
      [...base, '--task-class', 'invalid'], [...base, '--max-cost-class', 'free'], [...base, '--bogus'], [...base, '--tier', 'work']]) {
      expect(await cmdSubagent(args, { options })).toBe(2);
    }
    expect(await cmdSubagent(['--help'], { options })).toBe(0);
    expect(await cmdSubagent([...base, '--apply', '--json'], { options })).toBe(0);
    const id = JSON.parse(String(log.mock.calls.at(-1)![0])).record.id as string;
    expect(await cmdSubagent(['list', '--parent', input.parent_id, '--json'], { options })).toBe(0);
    expect(await cmdSubagent(['result', id, '--json'], { options })).toBe(0);
    expect(await cmdSubagent(['result', 'sa-0000000000000000'], { options })).toBe(1);
    expect(await cmdSubagent([...base, '--tools', 'web'], { options })).toBe(1);
  });
});
