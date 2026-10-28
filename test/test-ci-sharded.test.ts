import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceScripts = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const isolatedFiles = [
  'test/m342.dispatch-production-ledger.test.ts',
  'test/m395.effect-terminal-retention.test.ts',
  'test/m446.external-skill-git-capture.test.ts',
  'test/resource-engineering-setup-acceptance.test.ts',
  'test/resource-engineering-supervisor-acceptance.test.ts',
  'test/resource-engineering-supervisor-admission-acceptance.test.ts',
  'test/resource-console-engineering-acceptance.test.ts',
  'test/universe-firm-engineering-control.test.ts',
  'test/universe-engineering-handoff-recovery.test.ts',
  'test/universe-campaign-integration.test.ts',
  'test/resource-engineering-successor-acceptance.test.ts',
  'test/universe-supervision-integration.test.ts',
];
const markerFile = 'test/universe-hub-marker-campaign.test.ts';

function runFixture(
  failure: 'none' | 'middle' | 'isolated' | 'successor' | 'supervision' | 'signal' | 'balanced',
  phaseEnvironment: Record<string, string> = {},
  args: string[] = [],
  report?: 'private' | 'stale' | 'permissive' | 'sticky' | 'symlink' | 'relative' | 'missing' | 'empty' | 'file' | 'wrong-owner' | 'no-posix-owner',
  durations?: string,
) {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-test-ci-shards-')); roots.push(root);
  mkdirSync(join(root, 'scripts'));
  if (durations !== undefined) {
    mkdirSync(join(root, 'test', 'helpers'), { recursive: true });
    writeFileSync(join(root, 'test', 'helpers', 'test-durations.json'), durations);
  }
  mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
  const policy = join(root, 'src', 'core', 'run', 'tool-path.ts');
  mkdirSync(dirname(policy), { recursive: true });
  copyFileSync(resolve(sourceScripts, '..', 'src', 'core', 'run', 'tool-path.ts'), policy);
  for (const file of ['test-ci.mjs', 'test-ci-sharded.mjs', 'test-shard-plan.mjs']) {
    copyFileSync(join(sourceScripts, file), join(root, 'scripts', file));
  }
  // Keep fixture capacity deterministic; policy tests cover low-memory inputs.
  const fixtureWrapper = join(root, 'scripts', 'test-ci.mjs');
  expect(readFileSync(fixtureWrapper, 'utf8'), 'Fixture capacity call must match production').toContain('boundedVitestJob(process.env, process.argv.slice(2))');
  writeFileSync(fixtureWrapper, readFileSync(fixtureWrapper, 'utf8').replace(
    'boundedVitestJob(process.env, process.argv.slice(2))',
    'boundedVitestJob(process.env, process.argv.slice(2), 68719476736, 8)',
  ));
  let reportDirectory: string | undefined;
  if (report !== undefined) {
    reportDirectory = join(realpathSync(root), 'reports');
    if (report === 'file') writeFileSync(reportDirectory, '', { mode: 0o600 });
    else if (report !== 'missing') mkdirSync(reportDirectory, { mode: 0o700 });
    if (report === 'stale') writeFileSync(join(reportDirectory, 'general-2-of-4.json'), '{}');
    if (report === 'permissive') chmodSync(reportDirectory, 0o755);
    if (report === 'sticky') chmodSync(reportDirectory, 0o1700);
    if (report === 'symlink') {
      const alias = join(realpathSync(root), 'report-alias');
      symlinkSync(reportDirectory, alias, 'dir'); reportDirectory = alias;
    }
    if (report === 'relative') reportDirectory = 'reports';
    if (report === 'empty') reportDirectory = '';
    if (report === 'wrong-owner' || report === 'no-posix-owner') {
      // Simulate an unavailable/mismatched ownership witness in this copy only;
      // no privilege change, chown or production probe is involved.
      const path = join(root, 'scripts', 'test-ci-sharded.mjs');
      const prefix = report === 'wrong-owner'
        ? 'const fixtureUid = process.getuid?.() ?? 0; process.getuid = () => fixtureUid + 1;'
        : 'process.getuid = undefined;';
      writeFileSync(path, readFileSync(path, 'utf8').replace('\n', `\n${prefix}\n`));
    }
  }
  // The signal fixture alone tells its fake child the exact owned coordinator.
  if (failure === 'signal') {
    const path = join(root, 'scripts', 'test-ci-sharded.mjs');
    const source = readFileSync(path, 'utf8');
    writeFileSync(path, source.replace('\n', '\nprocess.env.ASHLR_FAKE_COORDINATOR_PID = String(process.pid);\n'));
  }
  writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), `
if (process.argv[2] === 'list') {
  // Balanced mode's inventory: ASHLR_FAKE_LIST names root-relative files.
  const output = process.argv.find((arg) => arg.startsWith('--json=')).slice('--json='.length);
  const files = (process.env.ASHLR_FAKE_LIST ?? '').split(',').filter(Boolean);
  (await import('node:fs')).writeFileSync(output, JSON.stringify(files.map((file) => ({ file: process.cwd() + '/' + file, projectName: 'unit' }))));
  process.exit(Number(process.env.ASHLR_FAKE_LIST_STATUS ?? 0));
}
const shard = process.argv.find((arg) => arg.startsWith('--shard='));
console.log(JSON.stringify({ pid: process.pid, wrapperPid: process.ppid, shard, files: process.argv.filter((arg) => arg.endsWith('.test.ts') && !arg.startsWith('--')), file: process.argv.find((arg) => arg.endsWith('.test.ts') && !arg.startsWith('--exclude=')), filter: process.argv.includes('-t') ? process.argv[process.argv.indexOf('-t') + 1] : undefined, excludes: process.argv.filter((arg) => arg.startsWith('--exclude=')), reporters: process.argv.filter((arg) => arg.startsWith('--reporter=')), outputFiles: process.argv.filter((arg) => arg.startsWith('--outputFile')), reportDirectory: process.env.ASHLR_TEST_CI_REPORT_DIRECTORY, workers: process.argv.find((arg) => arg.startsWith('--maxWorkers=')), unitWorkers: process.env.ASHLR_VITEST_UNIT_MAX_WORKERS, parallelism: process.argv.filter((arg) => arg.startsWith('--fileParallelism=')), bail: process.argv.find((arg) => arg.startsWith('--bail=')), home: process.env.HOME, tmp: process.env.TMPDIR, setupTiming: process.env.ASHLR_ENGINEERING_SETUP_PHASE_TIMING, successorTiming: process.env.ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING, admissionTiming: process.env.ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING, acceptanceTiming: process.env.ASHLR_ACCEPTANCE_PHASE_TIMING, weighted: process.env.ASHLR_TEST_CI_WEIGHTED_PARTITION, weightHints: process.env.ASHLR_TEST_CI_WEIGHTED_HINTS, hardTimeout: process.env.ASHLR_TEST_CI_TIMEOUT_MS, idleTimeout: process.env.ASHLR_TEST_CI_IDLE_TIMEOUT_MS }));
if (process.env.ASHLR_FAKE_FAILURE === 'signal') {
  if (shard === '--shard=3/4') setTimeout(() => {
    process.kill(Number(process.env.ASHLR_FAKE_COORDINATOR_PID), 'SIGTERM');
  }, 100);
  setInterval(() => {}, 1000);
} else if (process.env.ASHLR_FAKE_FAILURE === 'balanced' && process.argv.includes('test/g-fail.test.ts')) {
  setTimeout(() => { process.exitCode = 7; }, 100);
} else if (process.env.ASHLR_FAKE_FAILURE === 'balanced') {
  setInterval(() => {}, 1000);
} else if (process.env.ASHLR_FAKE_FAILURE === 'middle' && shard === '--shard=3/4') {
  setTimeout(() => { process.exitCode = 7; }, 100);
} else if (process.env.ASHLR_FAKE_FAILURE === 'middle') {
  setInterval(() => {}, 1000);
} else if (process.env.ASHLR_FAKE_FAILURE === 'successor' && process.argv.includes('test/resource-engineering-successor-acceptance.test.ts')) {
  process.exitCode = 11;
} else if (process.env.ASHLR_FAKE_FAILURE === 'supervision' && process.argv.includes('test/universe-supervision-integration.test.ts')) {
  process.exitCode = 12;
} else if (process.env.ASHLR_FAKE_FAILURE === 'isolated' && process.argv.includes('automatic seed measurement: true')) {
  process.exitCode = 9;
}
// Paired-mode fixtures hold passing isolated cases open so overlap is observable.
if (!shard && !process.exitCode && process.env.ASHLR_FAKE_ISOLATED_DELAY_MS) {
  setTimeout(() => {}, Number(process.env.ASHLR_FAKE_ISOLATED_DELAY_MS));
}
`, 'utf8');
  // Baseline defaults must be independent of the outer release's timing flags.
  // Clear only this fixture's copied environment, then apply caller overrides.
  const environment = { ...process.env };
  delete environment.ASHLR_ENGINEERING_SETUP_PHASE_TIMING;
  delete environment.ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING;
  delete environment.ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING;
  delete environment.ASHLR_ACCEPTANCE_PHASE_TIMING;
  delete environment.ASHLR_TEST_CI_REPORT_DIRECTORY;
  delete environment.ASHLR_TEST_CI_WEIGHTED_PARTITION;
  delete environment.ASHLR_TEST_CI_WEIGHTED_HINTS;
  delete environment.ASHLR_VITEST_UNIT_MAX_WORKERS;
  delete environment.ASHLR_TEST_CI_ISOLATED_CONCURRENCY;
  if (reportDirectory !== undefined) environment.ASHLR_TEST_CI_REPORT_DIRECTORY = reportDirectory;
  // A full run launches up to nineteen wrappers, most of them serially; on a
  // loaded host Node startup alone measured 8.2s for those launches. This only
  // bounds a hung coordinator: each wrapper keeps its 4s hard and idle caps.
  return spawnSync(process.execPath, [join(root, 'scripts', 'test-ci-sharded.mjs'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...environment, ...phaseEnvironment, ASHLR_FAKE_FAILURE: failure,
      ASHLR_TEST_CI_TIMEOUT_MS: '4000', ASHLR_TEST_CI_IDLE_TIMEOUT_MS: '4000',
      ASHLR_TEST_CI_TERMINATION_GRACE_MS: '100' },
  });
}

describe('local exhaustive prepublish shards', () => {
  it('requires all four exhaustive local shards with separate test homes and bounded workers', () => {
    const result = runFixture('none');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as {
      shard?: string; file?: string; filter?: string; excludes: string[]; workers: string; parallelism: string[]; bail: string; home: string; tmp: string; setupTiming: string; successorTiming: string; admissionTiming: string; acceptanceTiming: string; hardTimeout: string; idleTimeout: string; outputFiles: string[]; reporters: string[]; reportDirectory?: string;
    });
    expect(rows.filter((row) => row.shard).map((row) => row.shard).sort()).toEqual(['--shard=1/4', '--shard=2/4', '--shard=3/4', '--shard=4/4']);
    // Observe actual coordinator launches, independent of child log ordering.
    // All partitions run once; the same two queue consumers own the slots.
    expect([...result.stderr.matchAll(/started (\d)\/4/g)].map(match => Number(match[1]))).toEqual([4, 3, 2, 1]);
    // Ordered coordinator events prove the ceiling without fake sleeps/files.
    const active = new Set<number>(), started = new Set<number>(), ended = new Set<number>();
    let maximum = 0, isolatedStarts = 0;
    for (const line of result.stderr.split('\n')) {
      const start = /^\[test-ci:sharded\] started (\d)\/4 /.exec(line);
      const finish = /^\[test-ci:sharded\] (\d)\/4 exited 0$/.exec(line);
      if (start) {
        const shard = Number(start[1]); expect(started.has(shard)).toBe(false);
        started.add(shard); active.add(shard); maximum = Math.max(maximum, active.size);
        expect(active.size).toBeLessThanOrEqual(2);
      } else if (finish) {
        const shard = Number(finish[1]); expect(active.delete(shard)).toBe(true);
        expect(ended.has(shard)).toBe(false); ended.add(shard);
      } else if (line.startsWith('[test-ci:sharded] started isolated acceptance ')) {
        expect(active.size).toBe(0); isolatedStarts++;
      }
    }
    expect(maximum).toBe(2); expect(active.size).toBe(0);
    expect([...started].sort()).toEqual([1, 2, 3, 4]); expect(ended).toEqual(started);
    expect(isolatedStarts).toBe(14);
    expect(rows).toHaveLength(18);
    expect(rows.every((row) => row.setupTiming === '1' && row.successorTiming === '1' && row.admissionTiming === '1')).toBe(true);
    expect(rows.every((row) => row.acceptanceTiming === '1')).toBe(true);
    expect(rows.every((row) => row.hardTimeout === '4000' && row.idleTimeout === '4000')).toBe(true);
    expect(rows.filter((row) => row.shard).every((row) => row.excludes.length === 13 &&
      [...isolatedFiles, 'test/universe-hub-marker-campaign.test.ts'].every((file) =>
        row.excludes.includes(`--exclude=${file}`)))).toBe(true);
    expect(rows.filter((row) => !row.shard).map((row) => row.file)).toEqual([
      ...isolatedFiles,
      'test/universe-hub-marker-campaign.test.ts', 'test/universe-hub-marker-campaign.test.ts',
    ]);
    expect(rows.filter((row) => !row.shard).map((row) => row.filter)).toEqual([
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      'automatic seed measurement: false', 'automatic seed measurement: true',
    ]);
    expect(rows.every((row) => row.workers === '--maxWorkers=1')).toBe(true);
    expect(rows.every((row) => row.parallelism.length === 1 && row.parallelism[0] === '--fileParallelism=false')).toBe(true);
    expect(rows.every((row) => row.bail === '--bail=1')).toBe(true);
    expect(rows.every(row => row.outputFiles.length === 0 && row.reportDirectory === undefined &&
      row.reporters.length === 2 && !row.reporters.includes('--reporter=json'))).toBe(true);
    expect(new Set(rows.map((row) => row.home)).size).toBe(18);
    expect(rows.every((row) => row.tmp === join(row.home, 'tmp'))).toBe(true);
    expect(result.stderr).toContain('[test-ci:sharded] PASS');
  });

  it.each([1, 2, 3, 4])('runs only general shard %i/4 with the full shared exclusion set', (shard) => {
    const result = runFixture('none', {}, [`--general-shard=${shard}/4`]);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as {
      shard?: string; file?: string; excludes: string[]; workers: string; unitWorkers?: string; parallelism: string[]; bail: string; home: string;
    });
    expect(rows).toHaveLength(1);
    // Alone on its machine, the shard gets the two workers a full local run
    // spreads over two concurrent single-worker shards.
    expect(rows[0]).toMatchObject({
      shard: `--shard=${shard}/4`, workers: '--maxWorkers=2', unitWorkers: '1', parallelism: [], bail: '--bail=1',
    });
    expect(rows[0]?.file).toBeUndefined();
    expect(rows[0]?.excludes.sort()).toEqual([...isolatedFiles, markerFile].map(file => `--exclude=${file}`).sort());
    expect(result.stderr).toContain(`[test-ci:sharded] PASS (general ${shard}/4)`);
    expect(result.stderr).not.toContain('started isolated acceptance');
    expect(rows.every(row => !existsSync(row.home))).toBe(true);
  });

  it('keeps explicit weighted calibration on general lanes and removes it from every isolated child', () => {
    const calibration = { ASHLR_TEST_CI_WEIGHTED_PARTITION: '1', ASHLR_TEST_CI_WEIGHTED_HINTS: '/private/inert-hints.json' };
    const general = runFixture('none', calibration, ['--general-shard=1/4']);
    expect(general.status).toBe(0);
    expect(JSON.parse(general.stdout.trim())).toMatchObject({ shard: '--shard=1/4', weighted: '1', weightHints: '/private/inert-hints.json' });
    const isolated = runFixture('none', calibration, ['--isolated-only']);
    expect(isolated.status).toBe(0);
    const rows = isolated.stdout.trim().split('\n').map(line => JSON.parse(line) as { weighted?: string; weightHints?: string; shard?: string });
    expect(rows).toHaveLength(14);
    expect(rows.every(row => row.weighted === undefined && row.weightHints === undefined && row.shard === undefined)).toBe(true);
  });

  it('runs the complete isolated lane alone in fourteen separate homes', () => {
    const result = runFixture('none', {}, ['--isolated-only']);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as {
      shard?: string; file?: string; filter?: string; excludes: string[]; home: string; workers: string; parallelism: string[]; bail: string;
    });
    expect(rows).toHaveLength(14);
    expect(rows.every(row => row.shard === undefined && row.excludes.length === 0)).toBe(true);
    expect(rows.map(row => row.file)).toEqual([...isolatedFiles, markerFile, markerFile]);
    expect(rows.map(row => row.filter)).toEqual([
      ...isolatedFiles.map(() => undefined), 'automatic seed measurement: false', 'automatic seed measurement: true',
    ]);
    expect(rows.every(row => row.workers === '--maxWorkers=1' && row.bail === '--bail=1' &&
      row.parallelism.length === 1 && row.parallelism[0] === '--fileParallelism=false')).toBe(true);
    expect(new Set(rows.map(row => row.home)).size).toBe(14);
    expect(rows.every(row => !existsSync(row.home))).toBe(true);
    expect(result.stderr).not.toMatch(/started \d\/4/);
    expect(result.stderr).toContain('[test-ci:sharded] PASS (isolated ');
  });

  it.skipIf(process.platform === 'win32').each([
    { args: [], names: [...[1, 2, 3, 4].map(shard => `general-${shard}-of-4.json`),
      ...Array.from({ length: 14 }, (_, index) => `isolated-${String(index + 1).padStart(2, '0')}.json`)] },
    { args: ['--general-shard=2/4'], names: ['general-2-of-4.json'] },
    { args: ['--isolated-only'], names: Array.from({ length: 14 }, (_, index) => `isolated-${String(index + 1).padStart(2, '0')}.json`) },
  ])('assigns fixed JSON report names while retaining console/progress reporters: $args', ({ args, names }) => {
    const result = runFixture('none', {}, args, 'private');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as {
      reporters: string[]; outputFiles: string[]; reportDirectory: string;
    });
    expect(rows).toHaveLength(names.length);
    expect(rows.map(row => {
      expect(row.reporters).toHaveLength(3);
      expect(row.reporters).toContain('--reporter=default');
      expect(row.reporters).toContain('--reporter=json');
      expect(row.reporters.some(value => value.endsWith('vitest-progress-reporter.mjs'))).toBe(true);
      expect(row.outputFiles).toHaveLength(1);
      const output = row.outputFiles[0] ?? '';
      expect(output.startsWith('--outputFile.json=')).toBe(true);
      const file = output.slice('--outputFile.json='.length);
      expect(dirname(file)).toBe(row.reportDirectory);
      return basename(file);
    }).sort()).toEqual([...names].sort());
    expect(result.stderr).toContain('[test-ci:sharded] PASS');
  });

  it.skipIf(process.platform === 'win32').each([
    'stale', 'permissive', 'sticky', 'symlink', 'relative', 'missing', 'empty', 'file', 'wrong-owner',
  ] as const)('rejects unsafe report directory before any child launch: %s', (report) => {
    const result = runFixture('none', {}, ['--general-shard=2/4'], report);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Report directory must be empty, canonical, owned, and private (0700) on POSIX.');
    expect(result.stderr).not.toContain('[test-ci:sharded] started');
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it('fails report mode closed when POSIX ownership inspection is unavailable', () => {
    const result = runFixture('none', {}, ['--isolated-only'], 'no-posix-owner');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Report directory must be empty, canonical, owned, and private (0700) on POSIX.');
    expect(result.stderr).not.toContain('[test-ci:sharded] started');
  });

  it.each([
    ['--general-shard=0/4'], ['--general-shard=5/4'], ['--general-shard=1/3'], ['--general-shard=01/4'],
    ['--general-shard=1/4', '--isolated-only'], ['--isolated-only', '--isolated-only'],
    ['--general-shard=1/4', '--general-shard=2/4'], ['--isolated-only', '-t', 'arbitrary'],
    ['test/other.test.ts'], ['--shard=1/4'], ['--help'],
    ['--workers=0'], ['--workers=9'], ['--workers=04'], ['--workers'], ['--workers=4', '--isolated-only'],
  ])('rejects invalid selectors without launching children: %j', (...args) => {
    const result = runFixture('none', {}, args);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: test-ci-sharded.mjs');
    expect(result.stderr).not.toContain('[test-ci:sharded] started');
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it('propagates a selected general shard failure without starting any other lane', () => {
    const result = runFixture('middle', {}, ['--general-shard=3/4']);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(7);
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { shard: string; home: string });
    expect(rows).toHaveLength(1); expect(rows[0]?.shard).toBe('--shard=3/4');
    expect(rows.every(row => !existsSync(row.home))).toBe(true);
    expect(result.stderr).not.toContain('started isolated acceptance');
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it.each([
    { failure: 'successor' as const, code: 11, launched: 11 },
    { failure: 'supervision' as const, code: 12, launched: 12 },
    { failure: 'isolated' as const, code: 9, launched: 14 },
  ])('fails closed within the selected isolated lane: $failure', ({ failure, code, launched }) => {
    const result = runFixture(failure, {}, ['--isolated-only']);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(code);
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { shard?: string; file: string; home: string });
    expect(rows).toHaveLength(launched);
    expect(rows.every(row => row.shard === undefined && !existsSync(row.home))).toBe(true);
    expect(rows.map(row => row.file)).toEqual([...isolatedFiles, markerFile, markerFile].slice(0, launched));
    expect(result.stderr).not.toMatch(/started \d\/4/);
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it.each([
    { setup: '0', successor: '0', admission: '0', acceptance: '0' },
    { setup: '', successor: 'custom', admission: '', acceptance: '' },
    { setup: 'custom', successor: '', admission: 'custom', acceptance: 'custom' },
  ])('preserves explicit phase-output choices $setup/$successor/$admission/$acceptance for every child', ({ setup, successor, admission, acceptance }) => {
    const parentAcceptance = process.env.ASHLR_ACCEPTANCE_PHASE_TIMING;
    const result = runFixture('none', {
      ASHLR_ENGINEERING_SETUP_PHASE_TIMING: setup,
      ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING: successor,
      ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING: admission,
      ASHLR_ACCEPTANCE_PHASE_TIMING: acceptance,
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as {
      setupTiming: string; successorTiming: string; admissionTiming: string; acceptanceTiming: string; hardTimeout: string; idleTimeout: string;
    });
    expect(rows).toHaveLength(18);
    expect(rows.every((row) => row.setupTiming === setup && row.successorTiming === successor && row.admissionTiming === admission)).toBe(true);
    expect(rows.every((row) => row.acceptanceTiming === acceptance)).toBe(true);
    expect(process.env.ASHLR_ACCEPTANCE_PHASE_TIMING).toBe(parentAcceptance);
    expect(rows.every((row) => row.hardTimeout === '4000' && row.idleTimeout === '4000')).toBe(true);
    expect(result.stderr).toContain('[test-ci:sharded] PASS');
  });

  it.skipIf(process.platform === 'win32')('settles both owned wrappers on SIGTERM without launching pending shards or isolated suites', () => {
    const result = runFixture('signal');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(143);
    const starts = [...result.stderr.matchAll(/started (\d)\/4 \(pid (\d+)\)/g)];
    expect(starts.map(match => Number(match[1]))).toEqual([4, 3]);
    expect(result.stderr.match(/received SIGTERM/g)).toHaveLength(2);
    expect(result.stderr).toContain('[test-ci:sharded] FAIL');
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
    expect(result.stderr).not.toContain('started isolated acceptance');
    const rows = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as {
      shard?: string; file?: string; home: string; pid: number; wrapperPid: number;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => ['--shard=3/4', '--shard=4/4'].includes(row.shard ?? '') && !row.file)).toBe(true);
    const pids = new Set([...starts.map(match => Number(match[2])), ...rows.flatMap(row => [row.pid, row.wrapperPid])]);
    for (const pid of pids) {
      // Signal zero observes these fixture-owned PIDs; it never kills them.
      expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
    }
    expect(rows.every(row => !existsSync(row.home))).toBe(true);
  });

  it('fails closed and terminates sibling wrappers when one shard fails', () => {
    const result = runFixture('middle');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(7);
    expect(result.stderr).toContain('[test-ci:sharded] FAIL');
    expect(result.stderr.match(/received SIGTERM/g)).toHaveLength(1);
    expect(result.stdout).not.toContain('"file":"test/universe-hub-marker-campaign.test.ts"');
  });

  it('fails closed before marker cases when the whole isolated successor fixture fails', () => {
    const result = runFixture('successor');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(11);
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { file?: string; filter?: string });
    expect(rows).toHaveLength(15); // Four shards and eleven whole files; no marker case starts.
    expect(rows.at(-1)).toMatchObject({ file: 'test/resource-engineering-successor-acceptance.test.ts' });
    expect(rows.at(-1)?.filter).toBeUndefined();
    expect(result.stdout).not.toContain('"file":"test/universe-hub-marker-campaign.test.ts"');
    expect(result.stdout).not.toContain('"file":"test/universe-supervision-integration.test.ts"');
    expect(result.stderr).toContain('[test-ci:sharded] FAIL (0, 0, 0, 0, isolated 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11)');
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it('fails closed before marker cases when the whole isolated supervision fixture fails', () => {
    const result = runFixture('supervision');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(12);
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { file?: string; filter?: string });
    expect(rows).toHaveLength(16); // Four shards and twelve whole files; no marker case starts.
    expect(rows.at(-1)).toMatchObject({ file: 'test/universe-supervision-integration.test.ts' });
    expect(rows.at(-1)?.filter).toBeUndefined();
    expect(result.stdout).not.toContain('"file":"test/universe-hub-marker-campaign.test.ts"');
    expect(result.stderr).toContain('[test-ci:sharded] FAIL (0, 0, 0, 0, isolated 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12)');
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it('fails closed when the isolated campaign acceptance fails', () => {
    const result = runFixture('isolated');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(9);
    expect(result.stderr).toContain('[test-ci:sharded] FAIL (0, 0, 0, 0, isolated 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9)');
  });
});

describe('paired isolated acceptance', () => {
  const longestFirst = [
    'test/resource-engineering-setup-acceptance.test.ts',
    'test/resource-engineering-successor-acceptance.test.ts',
    'test/universe-firm-engineering-control.test.ts',
    'test/resource-engineering-supervisor-admission-acceptance.test.ts',
    'test/m342.dispatch-production-ledger.test.ts',
    'campaign false',
    'test/resource-engineering-supervisor-acceptance.test.ts',
    'test/resource-console-engineering-acceptance.test.ts',
    'test/universe-engineering-handoff-recovery.test.ts',
    'test/universe-campaign-integration.test.ts',
    'test/universe-supervision-integration.test.ts',
    'campaign true',
    'test/m446.external-skill-git-capture.test.ts',
    'test/m395.effect-terminal-retention.test.ts',
  ];
  const events = (stderr: string) => stderr.split('\n').flatMap((line) => {
    const start = /^\[test-ci:sharded\] started isolated acceptance (.+) \(pid /.exec(line);
    if (start) return [{ kind: 'start' as const, label: start[1]! }];
    const end = /^\[test-ci:sharded\] isolated (.+) (?:exited|failed)/.exec(line);
    return end ? [{ kind: 'end' as const, label: end[1]! }] : [];
  });

  it('runs every case once, longest first, with at most two active and original report names', () => {
    const result = runFixture('none', { ASHLR_TEST_CI_ISOLATED_CONCURRENCY: '2', ASHLR_FAKE_ISOLATED_DELAY_MS: '150' },
      ['--isolated-only'], 'private');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const ordered = events(result.stderr);
    expect(ordered.filter(event => event.kind === 'start').map(event => event.label)).toEqual(longestFirst);
    const active = new Set<string>(); let maximum = 0;
    for (const event of ordered) {
      if (event.kind === 'start') { active.add(event.label); maximum = Math.max(maximum, active.size); }
      else expect(active.delete(event.label)).toBe(true);
    }
    expect(maximum).toBe(2); expect(active.size).toBe(0);
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { file: string; filter?: string; home: string; outputFiles: string[] });
    expect(rows).toHaveLength(14);
    expect(new Set(rows.map(row => row.home)).size).toBe(14);
    const names = rows.map(row => basename(row.outputFiles.find(arg => arg.startsWith('--outputFile.json='))!.slice('--outputFile.json='.length)));
    const expected = [...isolatedFiles, markerFile, markerFile].map((file, index) => ({ file, name: `isolated-${String(index + 1).padStart(2, '0')}.json` }));
    for (const row of rows) {
      const index = row.file === markerFile ? (row.filter === 'automatic seed measurement: false' ? 12 : 13) : isolatedFiles.indexOf(row.file);
      expect(names[rows.indexOf(row)]).toBe(expected[index]!.name);
    }
    expect(result.stderr).toContain('[test-ci:sharded] PASS (isolated 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)');
  });

  it('stops the running sibling and launches nothing more when a paired case fails', () => {
    const result = runFixture('successor', { ASHLR_TEST_CI_ISOLATED_CONCURRENCY: '2', ASHLR_FAKE_ISOLATED_DELAY_MS: '3000' }, ['--isolated-only']);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(11);
    const starts = events(result.stderr).filter(event => event.kind === 'start').map(event => event.label);
    expect(starts).toEqual(longestFirst.slice(0, 2));
    expect(result.stderr).toMatch(/isolated test\/resource-engineering-setup-acceptance\.test\.ts exited (?!0\b)/);
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it.each(['0', '3', 'two', ''])('refuses isolated concurrency %j before launching anything', (value) => {
    const result = runFixture('none', { ASHLR_TEST_CI_ISOLATED_CONCURRENCY: value }, ['--isolated-only']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('started');
  });
});

describe('duration-balanced local shards', () => {
  const general = ['test/g-a.test.ts', 'test/g-b.test.ts', 'test/g-c.test.ts', 'test/g-d.test.ts', 'test/g-e.test.ts',
    'test/g-f.test.ts', 'test/g-g.test.ts', 'test/g-h.test.ts', 'test/g-fail.test.ts'];
  const isolatedSet = new Set([...isolatedFiles, markerFile]);
  const inventory = [...general, ...isolatedFiles, markerFile].join(',');
  // One dominant file and a tail of small ones: count-based splits leave one
  // shard far behind, measured LPT gives the long file a shard of its own.
  const durations = JSON.stringify({ schema: 'phantom-test-durations/v1', files: {
    'test/g-a.test.ts': 9000, 'test/g-b.test.ts': 3000, 'test/g-c.test.ts': 3000, 'test/g-d.test.ts': 2000,
    'test/g-e.test.ts': 2000, 'test/g-f.test.ts': 1000, 'test/g-g.test.ts': 1000, 'test/g-h.test.ts': 500,
    'test/g-fail.test.ts': 500, 'test/m342.dispatch-production-ledger.test.ts': 99999,
  } });
  type Row = { shard?: string; file?: string; files: string[]; filter?: string; excludes: string[]; workers: string;
    parallelism: string[]; bail: string; home: string; weighted?: string; outputFiles: string[] };
  const parse = (stdout: string) => stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
  const balancedRows = (rows: Row[]) => rows.filter(row => !row.shard && !isolatedSet.has(row.file ?? ''));
  const events = (stderr: string) => stderr.split('\n').flatMap((line) => {
    const start = /^\[test-ci:sharded\] started (\d\/\d|isolated acceptance .+) \(pid /.exec(line);
    if (start) return [{ kind: 'start' as const, label: start[1]!.replace('isolated acceptance ', 'isolated ') }];
    const end = /^\[test-ci:sharded\] (\d\/\d|isolated .+) (?:exited|failed)/.exec(line);
    return end ? [{ kind: 'end' as const, label: end[1]! }] : [];
  });

  it('runs every general file exactly once across four concurrent duration-balanced shards, then pairs isolated cases', () => {
    const result = runFixture('none', { ASHLR_FAKE_LIST: inventory, ASHLR_FAKE_ISOLATED_DELAY_MS: '150',
      ASHLR_TEST_CI_WEIGHTED_PARTITION: '1', ASHLR_TEST_CI_WEIGHTED_HINTS: '/private/inert-hints.json' },
    ['--workers=4'], 'private', durations);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = parse(result.stdout);
    const shards = balancedRows(rows);
    expect(shards).toHaveLength(4);
    expect(shards.flatMap(row => row.files).sort()).toEqual([...general].sort());
    // LPT over the measured costs: 9000 | 3000+2000+500 | 3000+1000+500... every bin is planned up front.
    expect(shards.map(row => row.files.slice().sort())).toEqual(expect.arrayContaining([['test/g-a.test.ts']]));
    expect(result.stderr).toContain('[test-ci:sharded] balanced 4 shards by measured duration: 1 files ~9s | ');
    expect(result.stderr).not.toContain('unmeasured');
    expect(shards.every(row => row.workers === '--maxWorkers=1' && row.bail === '--bail=1' &&
      row.parallelism.length === 1 && row.parallelism[0] === '--fileParallelism=false' &&
      row.weighted === undefined && row.excludes.length === 13)).toBe(true);
    expect(shards.map(row => basename(row.outputFiles[0]!.slice('--outputFile.json='.length))).sort())
      .toEqual(['balanced-1-of-4.json', 'balanced-2-of-4.json', 'balanced-3-of-4.json', 'balanced-4-of-4.json']);
    const isolated = rows.filter(row => isolatedSet.has(row.file ?? ''));
    expect(isolated).toHaveLength(14);
    expect(new Set(rows.map(row => row.home)).size).toBe(18);
    // All four shards overlap; isolated cases start only after the last shard
    // ends and then run at most two at a time.
    const active = new Set<string>(); let generalPeak = 0, isolatedPeak = 0;
    for (const event of events(result.stderr)) {
      if (event.kind === 'end') { expect(active.delete(event.label)).toBe(true); continue; }
      if (event.label.startsWith('isolated ')) {
        expect([...active].some(label => !label.startsWith('isolated '))).toBe(false);
        active.add(event.label); isolatedPeak = Math.max(isolatedPeak, active.size);
      } else { active.add(event.label); generalPeak = Math.max(generalPeak, active.size); }
    }
    expect(generalPeak).toBe(4); expect(isolatedPeak).toBe(2); expect(active.size).toBe(0);
    expect(result.stderr).toContain('[test-ci:sharded] PASS (0, 0, 0, 0, isolated 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)');
  });

  it('keeps isolated cases serial below four workers and honors an explicit isolated concurrency', () => {
    const two = runFixture('none', { ASHLR_FAKE_LIST: inventory }, ['--workers=2'], undefined, durations);
    expect(two.status).toBe(0);
    expect(balancedRows(parse(two.stdout))).toHaveLength(2);
    let active = 0, peak = 0;
    for (const event of events(two.stderr).filter(event => event.label.startsWith('isolated '))) {
      active += event.kind === 'start' ? 1 : -1; peak = Math.max(peak, active);
    }
    expect(peak).toBe(1);
    const serial = runFixture('none', { ASHLR_FAKE_LIST: inventory, ASHLR_TEST_CI_ISOLATED_CONCURRENCY: '1' }, ['--workers=4'], undefined, durations);
    expect(serial.status).toBe(0);
    expect(parse(serial.stdout).filter(row => isolatedSet.has(row.file ?? '')).map(row => row.file))
      .toEqual([...isolatedFiles, markerFile, markerFile]);
  });

  it.each([
    ['missing', undefined],
    ['invalid', JSON.stringify({ schema: 'phantom-test-durations/v1', files: { '../escape.test.ts': 1 } })],
  ])('still runs the complete inventory when durations are %s', (_name, text) => {
    const result = runFixture('none', { ASHLR_FAKE_LIST: inventory }, ['--workers=3'], undefined, text);
    expect(result.status).toBe(0);
    const shards = balancedRows(parse(result.stdout));
    expect(shards).toHaveLength(3);
    expect(shards.flatMap(row => row.files).sort()).toEqual([...general].sort());
    expect(shards.map(row => row.files.length)).toEqual([3, 3, 3]);
    expect(result.stderr).toContain('9 unmeasured files estimated at 1000ms');
    if (text !== undefined) expect(result.stderr).toContain('ignoring durations (invalid durations path');
  });

  it.each([
    ['a failing vitest list', { ASHLR_FAKE_LIST: inventory, ASHLR_FAKE_LIST_STATUS: '3' }, 'vitest list failed'],
    ['an empty inventory', { ASHLR_FAKE_LIST: '' }, 'vitest list returned no test files'],
    ['a filter that would also select a nested file', { ASHLR_FAKE_LIST: `${inventory},test/xtest/g-a.test.ts` },
      'filter test/g-a.test.ts would select 2 collected files'],
  ])('refuses to plan with %s and launches nothing', (_name, environment, message) => {
    const result = runFixture('none', environment, ['--workers=4']);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`[test-ci:sharded] cannot plan balanced shards: ${message}`);
    expect(result.stderr).not.toContain('[test-ci:sharded] started');
  });

  it('stops every sibling shard and starts no isolated case when one balanced shard fails', () => {
    const result = runFixture('balanced', { ASHLR_FAKE_LIST: inventory }, ['--workers=4'], undefined, durations);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(7);
    expect(result.stderr.match(/received SIGTERM/g)).toHaveLength(3);
    expect(result.stderr).not.toContain('started isolated acceptance');
    expect(result.stderr).toContain('[test-ci:sharded] FAIL');
    expect(parse(result.stdout).every(row => !existsSync(row.home))).toBe(true);
  });
});

describe('recording measured durations', () => {
  function recordFixture(existing: string | undefined, reports: (root: string) => Record<string, unknown>) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-test-durations-'))); roots.push(root);
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'test', 'helpers'), { recursive: true });
    copyFileSync(join(sourceScripts, 'test-shard-plan.mjs'), join(root, 'scripts', 'test-shard-plan.mjs'));
    for (const file of ['test/kept.test.ts', 'test/fresh.test.ts']) writeFileSync(join(root, file), '');
    const durationsFile = join(root, 'test', 'helpers', 'test-durations.json');
    if (existing !== undefined) writeFileSync(durationsFile, existing);
    const directory = join(root, 'reports'); mkdirSync(directory);
    for (const [name, report] of Object.entries(reports(root))) writeFileSync(join(directory, name), JSON.stringify(report));
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'test-shard-plan.mjs'), '--from-reports', directory],
      { cwd: root, encoding: 'utf8', timeout: 8_000 });
    const read = () => readFileSync(durationsFile, 'utf8');
    return { result, read };
  }

  it('replaces observed files, keeps unobserved live ones and prunes deleted tests', () => {
    const existing = JSON.stringify({ schema: 'phantom-test-durations/v1', files: {
      'test/kept.test.ts': 1234, 'test/fresh.test.ts': 1, 'test/deleted.test.ts': 99 } });
    const { result, read } = recordFixture(existing, (root) => ({
      'general-1-of-4.json': { success: true, testResults: [{ name: join(root, 'test/fresh.test.ts'), startTime: 1000, endTime: 3500.6 }] },
    }));
    expect(result.status, result.stderr).toBe(0);
    expect(read()).toBe(`${JSON.stringify({ schema: 'phantom-test-durations/v1', files: {
      'test/fresh.test.ts': 2501, 'test/kept.test.ts': 1234 } }, null, 2)}\n`);
    expect(result.stderr).toContain('recorded 1 measured files (2 total)');
  });

  it('refuses reports from a failing run and leaves durations untouched', () => {
    const existing = JSON.stringify({ schema: 'phantom-test-durations/v1', files: { 'test/kept.test.ts': 5 } });
    const { result, read } = recordFixture(existing, (root) => ({
      'general-1-of-4.json': { success: false, testResults: [{ name: join(root, 'test/kept.test.ts'), startTime: 0, endTime: 9 }] },
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing durations from a failing run');
    expect(read()).toBe(existing);
  });

  it('rejects an empty report directory and prints usage without arguments', () => {
    const { result } = recordFixture(undefined, () => ({}));
    expect(result.status).toBe(1);
    const usage = spawnSync(process.execPath, [join(sourceScripts, 'test-shard-plan.mjs')], { encoding: 'utf8', timeout: 8_000 });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('Usage: test-shard-plan.mjs --from-reports');
  });
});
