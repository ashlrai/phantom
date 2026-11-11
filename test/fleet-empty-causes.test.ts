import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyEmptyCause,
  emptyFinishes,
  laneEmptyCandidates,
  laneEmptyRate,
  promptPool,
  withoutPromptEcho,
  type EmptyFinish,
  type EmptyJobEvidence,
  type LaneEmptyCausesV1,
} from '../src/core/fleet/lane-empty-causes.js';
import { cmdFleetEmptyCauses } from '../src/cli/fleet-empty-causes.js';

const LANE = 'codex-personal';
const none: EmptyJobEvidence = { log: null, notes: null, prompt: null, timedOut: false };
const finish = (over: Partial<EmptyFinish> = {}): EmptyFinish =>
  ({ job: 'RQ-A', lane: LANE, ms: 0, exitCode: 0, poolError: null, tokensTotal: 1200, ...over });
const classify = (evidence: Partial<EmptyJobEvidence>, row: EmptyFinish | null = finish()) =>
  classifyEmptyCause('RQ-A', LANE, row, { ...none, ...evidence });
const PROMPT = [
  'Job RQ-A (pool codex-personal, tier work, repo phantom). Task from the Ashlr router queue, verbatim:',
  '',
  'RQ-A (P1, pool=devin, tier=work, repo=phantom): wire the cache into the reader',
  '',
  'If the full goal cannot be verified, ship the smallest correct part. Use EMPTY only when already done or truly impossible.',
  'If your task is already covered, finish with a short note. Tests that time out are a timeout problem.',
].join('\n');

/** dispatch-events.log lines: `YYYY-MM-DD HH:MM:SS KIND args`. */
function events(rows: Array<[minute: number, kind: string, args: string]>): string {
  return rows.map(([minute, kind, args]) => {
    const clock = `${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`;
    return `2026-11-10 ${clock} ${kind} ${args}`;
  }).join('\n');
}

describe('classifyEmptyCause', () => {
  it('trusts an EMPTY_REASON line first, from notes or log', () => {
    expect(classify({ notes: 'EMPTY_REASON: duplicate-landed (#4701)\nsummary', log: 'ERROR: 401 Unauthorized' }))
      .toMatchObject({ cause: 'duplicate-landed', signals: expect.arrayContaining(['empty-reason-notes']) });
    expect(classify({ log: 'work...\n**EMPTY_REASON**: prompt-unclear' }).cause).toBe('prompt-unclear');
    expect(classify({ log: 'EMPTY_REASON: blocked' }).cause).toBe('launch-auth-error');
    expect(classify({ notes: '- EMPTY_REASON: no-change-needed' }).cause).toBe('duplicate-landed');
  });

  it('ignores the EMPTY_REASON template the launcher prints in the prompt', () => {
    const rule = 'If you finish with no change, end your final message with the line EMPTY_REASON: <code> and put it first.';
    expect(classify({ log: rule, prompt: rule }).cause).toBe('no-diff');
    expect(classify({ log: 'EMPTY_REASON: <code>' }).cause).toBe('no-diff');
  });

  it('names timeouts from the dispatcher marker or a kill exit', () => {
    expect(classify({ timedOut: true }).cause).toBe('timeout');
    expect(classify({}, finish({ exitCode: 137 })).cause).toBe('timeout');
    expect(classify({ notes: 'the test suite timed out after 10 minutes' }).cause).toBe('timeout');
  });

  it('names launch and auth errors from dispatcher fields and anchored provider lines', () => {
    expect(classify({}, finish({ exitCode: 1, poolError: 'rate_limit' })).cause).toBe('launch-auth-error');
    expect(classify({ log: 'thinking\nERROR: unexpected status 401 Unauthorized: token has expired' }).cause).toBe('launch-auth-error');
    expect(classify({ log: 'API Error: 429 {"type":"rate_limit_error"}' }).cause).toBe('launch-auth-error');
    expect(classify({ log: 'launch.sh: line 4: codex: command not found' }).cause).toBe('launch-auth-error');
    expect(classify({}, finish({ exitCode: 2, tokensTotal: null })).cause).toBe('launch-auth-error');
    // A nonzero exit after real work is not a launch failure.
    expect(classify({}, finish({ exitCode: 2, tokensTotal: 90_000 })).cause).toBe('no-diff');
  });

  it('maps the shared note rules and unclear phrasing', () => {
    expect(classify({ notes: 'This was already merged in #4600.' }).cause).toBe('duplicate-landed');
    expect(classify({ notes: 'The task is too broad to finish.' }).cause).toBe('prompt-unclear');
    expect(classify({ log: 'The request is ambiguous about which reader to change.' }).cause).toBe('prompt-unclear');
    expect(classify({}).cause).toBe('no-diff');
    expect(classify({}, null)).toMatchObject({ cause: 'no-diff', reason: 'Notes and log were unavailable.' });
  });

  it('does not read the echoed prompt as evidence', () => {
    // Every rule-bearing phrase here comes from the prompt echo, not the agent.
    expect(classify({ log: `${PROMPT}\ntokens used\n41,200`, prompt: PROMPT }).cause).toBe('no-diff');
    expect(classify({ log: `${PROMPT}\nNothing to do: already merged upstream.`, prompt: PROMPT }).cause).toBe('duplicate-landed');
  });

  it('flags a lane re-route and never echoes text into the result', () => {
    const result = classify({ prompt: PROMPT, notes: 'secret-looking sk-test value, already done' });
    expect(result.signals).toContain('rerouted-from-devin');
    expect(JSON.stringify(result)).not.toContain('sk-test');
  });
});

describe('pure helpers', () => {
  it('reads the pool attr from the task line only', () => {
    expect(promptPool('RQ-A', PROMPT)).toBe('devin');
    expect(promptPool('RQ-A', 'RQ-A (P1, repo=phantom): pool=devin in the text')).toBeNull();
    expect(promptPool('RQ-A', 'RQ-A (unterminated pool=devin')).toBeNull();
    expect(promptPool('RQ-A', null)).toBeNull();
  });

  it('drops only prompt lines from the log', () => {
    expect(withoutPromptEcho('a line from the prompt\nagent says hi there', 'a line from the prompt')).toBe('agent says hi there');
    expect(withoutPromptEcho(null, 'x')).toBeNull();
  });

  it('keeps the newest finish per job and drops jobs whose newest finish produced work', () => {
    const text = [
      { event: 'finish', job: 'RQ-A', lane: LANE, empty: true, exit_code: 0, ts: '2026-11-10T10:00:00Z' },
      { event: 'finish', job: 'RQ-A', lane: LANE, empty: false, exit_code: 0, ts: '2026-11-10T11:00:00Z' },
      { event: 'finish', job: 'RQ-B', lane: LANE, empty: false, ts: '2026-11-10T10:00:00Z' },
      { event: 'finish', job: 'RQ-B', lane: LANE, empty: true, exit_code: 1, pool_error: 'usage_limit', tokens_total: null, ts: '2026-11-10T11:00:00-0500' },
      { event: 'finish', job: 'RQ-C', lane: 'devin', empty: true, ts: '2026-11-10T10:00:00Z' },
      { event: 'finish', job: '../etc', lane: LANE, empty: true, ts: '2026-11-10T10:00:00Z' },
    ].map(row => JSON.stringify(row)).join('\n') + '\nnot json "finish"';
    const out = emptyFinishes(text, LANE);
    expect([...out.keys()]).toEqual(['RQ-B']);
    expect(out.get('RQ-B')).toMatchObject({ exitCode: 1, poolError: 'usage_limit', tokensTotal: null, ms: Date.parse('2026-11-10T16:00:00Z') });
  });

  it('joins both sources newest first with one row per job and a limit', () => {
    const ev = events([
      [0, 'LAUNCH', `RQ-E1 phantom ${LANE} work`], [5, 'EMPTY', 'RQ-E1'],
      [1, 'LAUNCH', `RQ-E2 phantom ${LANE} work`], [9, 'EMPTY_DONE', 'RQ-E2'],
      [2, 'LAUNCH', 'RQ-D1 phantom devin work'], [6, 'EMPTY', 'RQ-D1'],
      [3, 'LAUNCH', `RQ-P1 phantom ${LANE} work`], [7, 'PUBLISHED', 'RQ-P1 https://github.com/x/y/pull/1'],
    ]);
    const jobs = JSON.stringify({ event: 'finish', job: 'RQ-E1', lane: LANE, empty: true, exit_code: 0, ts: '2026-11-10T10:30:00Z' });
    const rows = laneEmptyCandidates(ev, jobs, LANE, 10);
    expect(rows.map(row => row.job)).toEqual(['RQ-E1', 'RQ-E2']);
    expect(rows[0]!.finish?.exitCode).toBe(0);
    expect(laneEmptyCandidates(ev, null, LANE, 1).map(row => row.job)).toEqual(['RQ-E2']);
    expect(laneEmptyCandidates(null, null, LANE, 10)).toEqual([]);
  });

  it('computes the rate over the newest ended launches of the lane only', () => {
    const rows: Array<[number, string, string]> = [];
    for (let i = 0; i < 30; i++) {
      rows.push([i * 2, 'LAUNCH', `RQ-J${i} phantom ${LANE} work`]);
      // The oldest 10 published, the newest 20 split 13 empty / 7 published.
      const empty = i >= 10 && (i - 10) % 3 !== 0;
      rows.push([i * 2 + 1, empty ? 'EMPTY' : 'PUBLISHED', empty ? `RQ-J${i}` : `RQ-J${i} https://x/pull/${i}`]);
    }
    rows.push([70, 'LAUNCH', `RQ-RUNNING phantom ${LANE} work`], [71, 'LAUNCH', 'RQ-OTHER phantom devin work'], [72, 'EMPTY', 'RQ-OTHER']);
    expect(laneEmptyRate(events(rows), LANE, 20)).toEqual({ window: 20, ended: 20, empties: 13, published: 7, rate: 0.65 });
    expect(laneEmptyRate(null, LANE, 20)).toEqual({ window: 20, ended: 0, empties: 0, published: 0, rate: null });
  });
});

describe('phm fleet empty-causes', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  async function fixture(): Promise<{ runs: string; wt: string }> {
    const root = await mkdtemp(join(tmpdir(), 'empty-causes-'));
    dirs.push(root);
    const runs = join(root, 'runs');
    const wt = join(root, 'wt');
    await mkdir(join(runs, 'queue', 'run'), { recursive: true });
    await mkdir(join(runs, 'queue', 'prompts'), { recursive: true });
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await mkdir(join(wt, 'RQ-DUP'), { recursive: true });
    await writeFile(join(runs, 'dispatch-events.log'), events([
      [0, 'LAUNCH', `RQ-DUP phantom ${LANE} work`], [10, 'EMPTY', 'RQ-DUP'],
      [1, 'LAUNCH', `RQ-SLOW phantom ${LANE} work`], [11, 'EMPTY', 'RQ-SLOW'],
      [2, 'LAUNCH', `RQ-AUTH phantom ${LANE} work`], [12, 'EMPTY', 'RQ-AUTH'],
      [3, 'LAUNCH', `RQ-OK phantom ${LANE} work`], [13, 'PUBLISHED', 'RQ-OK https://github.com/a/b/pull/9'],
    ]) + '\n');
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      { event: 'finish', job: 'RQ-AUTH', lane: LANE, empty: true, exit_code: 1, tokens_total: null, ts: '2026-11-10T10:12:00Z' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    await writeFile(join(wt, 'RQ-DUP', 'BRIDGE_NOTES.md'), 'EMPTY_REASON: duplicate-landed (#4701)\n');
    await writeFile(join(runs, 'queue', 'run', 'RQ-SLOW.timeout'), '');
    await writeFile(join(runs, 'RQ-AUTH.log'), 'ERROR: unexpected status 401 Unauthorized\n');
    return { runs, wt };
  }

  async function run(args: string[], runs: string, wt: string): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await cmdFleetEmptyCauses(args, {
      runsDir: runs, worktreesDir: wt, now: () => Date.parse('2026-11-10T12:00:00Z'),
      out: line => out.push(line), err: line => err.push(line),
    });
    return { code, out, err };
  }

  it('reports the rate and one cause per empty run as JSON', async () => {
    const { runs, wt } = await fixture();
    const { code, out } = await run(['--lane', LANE, '--json'], runs, wt);
    expect(code).toBe(0);
    const report = JSON.parse(out[0]!) as LaneEmptyCausesV1;
    expect(report).toMatchObject({
      schema: 'fleet.lane-empty-causes.v1', lane: LANE, total: 3,
      sources: { events: 'ok', jobs: 'ok' },
      rate: { window: 20, ended: 4, empties: 3, published: 1, rate: 0.75 },
      counts: { 'duplicate-landed': 1, timeout: 1, 'launch-auth-error': 1, 'prompt-unclear': 0, 'no-diff': 0 },
    });
    expect(report.jobs.map(job => [job.job, job.cause])).toEqual([
      ['RQ-AUTH', 'launch-auth-error'], ['RQ-SLOW', 'timeout'], ['RQ-DUP', 'duplicate-landed'],
    ]);
    expect(report.causes.map(cause => cause.fixArea)).toEqual(['admission-dedupe', 'lane-routing', 'lane-routing']);
    expect(out[0]).not.toContain('401');
  });

  it('gates on --max-rate and prints a human summary', async () => {
    const { runs, wt } = await fixture();
    const high = await run(['--lane', LANE, '--max-rate', '0.30'], runs, wt);
    expect(high.code).toBe(2);
    expect(high.out[0]).toBe(`${LANE}: empty rate 0.75 (3 of 4 ended launches, window 20)`);
    expect(high.out.some(line => line.startsWith('duplicate-landed: 1 (33%), fix area admission-dedupe'))).toBe(true);
    expect((await run(['--lane', LANE, '--max-rate', '0.8'], runs, wt)).code).toBe(0);
  });

  it('is honest when the runs dir is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'empty-causes-none-'));
    dirs.push(root);
    const { code, out } = await run(['--lane', LANE], join(root, 'missing'), root);
    expect(code).toBe(0);
    expect(out[0]).toBe(`${LANE}: dispatch events unavailable, rate unknown`);
    expect(out[1]).toBe('0 empty runs classified (newest 40), jobs ledger unavailable');
  });

  it('rejects bad flags and requires a lane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'empty-causes-args-'));
    dirs.push(root);
    for (const args of [[], ['--lane', '../x'], ['--lane', LANE, '--last', '0'], ['--lane', LANE, '--max-rate', '2'], ['--lane', LANE, '--bogus']]) {
      expect((await run(args, root, root)).code).toBe(1);
    }
    const help = await run(['--help'], root, root);
    expect(help.code).toBe(0);
    expect(help.out[0]).toContain('phm fleet empty-causes --lane');
  });
});
