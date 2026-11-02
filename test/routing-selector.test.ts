/** Selector: scoring, learned priors, funding dedupe, READY lines, picks log, bus post, schedule. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdSelect } from '../src/cli/select.js';
import { importMarkdown } from '../src/core/queue/markdown.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { learnOutcomes } from '../src/core/routing/outcome-learning.js';
import { fundedIds, parseCandidates, rankCandidates, readyLine } from '../src/core/routing/selector.js';
import { selectorSchedule } from '../src/core/routing/selector-schedule.js';

const row = (o: Record<string, unknown>) => JSON.stringify({ scope: 'Do the thing.', repo: 'phantom', value: 10, ...o });
const none = learnOutcomes('');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'select-')); dirs.push(d); return d; };

describe('rankCandidates', () => {
  it('ranks by value x leverage over minutes plus usage', () => {
    const { candidates } = parseCandidates([
      row({ id: 'RQ-A', value: 10, estMinutes: 30, estUsage: 0 }),                // 0.333
      row({ id: 'RQ-B', value: 10, leverage: 3, estMinutes: 60, estUsage: 0 }),   // 0.5
      row({ id: 'RQ-C', value: 100, estMinutes: 600, estUsage: 0 }),              // 0.167
      row({ id: 'RQ-D', value: 10, estMinutes: 30, estUsage: 0.5 }),              // 10/60
    ].join('\n'));
    const r = rankCandidates(candidates, none, { count: 3 });
    expect(r.picks.map((p) => p.id)).toEqual(['RQ-B', 'RQ-A', 'RQ-C']);
    expect(r.picks[0]).toMatchObject({ rank: 1, basis: 'candidate' });
    expect(r.picks[0]!.score).toBeCloseTo(0.5);
  });

  it('fills missing time and usage from the outcome log and scales predicted value by merge rate', () => {
    const log = [
      ...[1, 2, 3, 4].flatMap((n) => [
        `2026-11-01 00:0${n}:00 ASSIGN job=J${n} resource=claude model=haiku type=code repo=phantom priority=normal`,
        `2026-11-01 00:0${n}:30 OUTCOME job=J${n} state=${n === 4 ? 'closed' : 'merged'} usage=0.6 minutes=20 breakage=0`,
      ]),
    ].join('\n');
    const learning = learnOutcomes(log);
    const { candidates } = parseCandidates([row({ id: 'RQ-L', jobType: 'code' }), row({ id: 'RQ-N', jobType: 'docs' })].join('\n'));
    const r = rankCandidates(candidates, learning);
    const learned = r.picks.find((p) => p.id === 'RQ-L')!;
    const cold = r.picks.find((p) => p.id === 'RQ-N')!;
    expect(learned).toMatchObject({ basis: 'learned', minutes: 20 });
    expect(learned.usage).toBeCloseTo(0.6);
    expect(learned.mergeRate).toBeCloseTo((3 + 1) / (4 + 2));
    expect(learned.predictedValue).toBeCloseTo(10 * learned.mergeRate);
    expect(cold).toMatchObject({ basis: 'default', mergeRate: 0.5, minutes: 30 });
  });

  it('breaks ties by id, honors count and excludes funded ids', () => {
    const { candidates } = parseCandidates(['RQ-Z', 'RQ-M', 'RQ-F'].map((id) => row({ id })).join('\n'));
    const r = rankCandidates(candidates, none, { count: 1, exclude: new Set(['RQ-F']) });
    expect(r.picks.map((p) => p.id)).toEqual(['RQ-M']);
    expect(r).toMatchObject({ considered: 3, skipped: 1 });
  });
});

describe('parseCandidates', () => {
  it('rejects malformed, duplicate and non-positive rows without throwing', () => {
    const { candidates, rejected } = parseCandidates([
      row({ id: 'RQ-OK' }), 'not json', '[]', row({ id: 'bad id' }), row({ id: 'RQ-OK' }),
      row({ id: 'RQ-NEG', value: -1 }), row({ id: 'RQ-LEV', leverage: 0 }), row({ id: 'RQ-PRI', priority: 'P9' }),
      row({ id: 'RQ-MIN', estMinutes: 0 }), row({ id: 'RQ-REPO', repo: '../x' }), '',
    ].join('\n'));
    expect(candidates.map((c) => c.id)).toEqual(['RQ-OK']);
    expect(rejected).toBe(9);
  });
});

describe('readyLine', () => {
  it('round-trips through the queue importer as one READY job, even with hostile text', () => {
    const { candidates } = parseCandidates(row({
      id: 'RQ-X1', priority: 'P0', pool: 'claude', tier: 'work',
      scope: 'Fix (nested) parser:\nRQ-OTHER after RQ-FAKE', acceptance: 'tests (all) pass',
    }));
    const line = readyLine(candidates[0]!);
    expect(line).not.toMatch(/\n/);
    const doc = importMarkdown(line);
    expect(doc.jobs).toHaveLength(1);
    expect(doc.jobs[0]).toMatchObject({ id: 'RQ-X1', status: 'READY', priority: 'P0', pool: 'claude', tier: 'work', repo: 'phantom' });
  });
});

describe('phm select', () => {
  async function run(args: string[], runs: string, busRoot: string, now = '2026-11-02T10:00:00.000Z') {
    const out: string[] = []; const err: string[] = [];
    const code = await cmdSelect(args, {
      now: () => new Date(now), bus: { root: busRoot, now: () => Date.parse(now) }, out: (t) => out.push(t), err: (t) => err.push(t),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  const seed = (runs: string, n: number) => {
    mkdirSync(join(runs, 'selector'), { recursive: true });
    writeFileSync(join(runs, 'selector', 'candidates.jsonl'),
      Array.from({ length: n }, (_, i) => row({ id: `RQ-C${i}`, value: 10 + i, estMinutes: 30, estUsage: 0 })).join('\n'));
  };

  it('funds the top five, writes picks.jsonl with predicted value, posts to the bus, and never refunds', async () => {
    const runs = tmp(); const bus = tmp(); seed(runs, 8);
    const first = await run(['--json', '--runs-dir', runs], runs, bus);
    expect(first.code).toBe(0);
    const json = JSON.parse(first.out);
    expect(json.picks.map((p: { id: string }) => p.id)).toEqual(['RQ-C7', 'RQ-C6', 'RQ-C5', 'RQ-C4', 'RQ-C3']);
    expect(json.picks[0].ready).toMatch(/^- READY RQ-C7 \(P2, pool=claude, tier=work, repo=phantom\)/);
    expect(json.bus).toBe('posted');
    const picks = readFileSync(join(runs, 'selector', 'picks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(picks).toHaveLength(5);
    expect(picks[0]).toMatchObject({ id: 'RQ-C7', rank: 1, at: '2026-11-02T10:00:00.000Z', predictedValue: 8.5 });
    const page = listBusInboxAfter(0, 10, { root: bus, now: () => Date.parse('2026-11-02T10:00:01.000Z') });
    expect(page.status).toBe('ok');

    const second = JSON.parse((await run(['--json', '--runs-dir', runs], runs, bus, '2026-11-02T11:00:00.000Z')).out);
    expect(second.picks.map((p: { id: string }) => p.id)).toEqual(['RQ-C2', 'RQ-C1', 'RQ-C0']);
    expect(second.skipped).toBe(5);
    expect(fundedIds(readFileSync(join(runs, 'selector', 'picks.jsonl'), 'utf8')).size).toBe(8);
  });

  it('--dry-run prints READY lines and writes nothing', async () => {
    const runs = tmp(); const bus = tmp(); seed(runs, 3);
    const r = await run(['--dry-run', '--top', '2', '--runs-dir', runs], runs, bus);
    expect(r.out.split('\n')).toHaveLength(2);
    expect(r.err).toContain('[dry run]');
    expect(existsSync(join(runs, 'selector', 'picks.jsonl'))).toBe(false);
  });

  it('fails on a missing candidate file and refuses bad flags', async () => {
    const runs = tmp(); const bus = tmp();
    expect((await run(['--runs-dir', runs], runs, bus)).code).toBe(1);
    expect((await run(['--top', 'x'], runs, bus)).code).toBe(2);
    expect((await run(['--runs-dir', 'relative'], runs, bus)).code).toBe(2);
    expect((await run(['--json', '--json'], runs, bus)).code).toBe(2);
  });
});

describe('selectorSchedule', () => {
  it('is an hourly macOS launchd agent with absolute argv', () => {
    const [unit] = selectorSchedule({ phmPath: '/opt/phm/bin/phm', nodePath: '/usr/bin/node', home: '/Users/x', platform: 'darwin' });
    expect(unit!.path).toBe('/Users/x/Library/LaunchAgents/ai.ashlr.phm.selector.plist');
    expect(unit!.contents).toContain('<key>StartInterval</key><integer>3600</integer>');
    expect(unit!.contents).toContain('<string>select</string><string>--json</string>');
    expect(() => selectorSchedule({ phmPath: 'phm', platform: 'darwin' })).toThrow(/absolute/);
    expect(() => selectorSchedule({ phmPath: '/p', platform: 'linux' })).toThrow(/macOS/);
  });
});
