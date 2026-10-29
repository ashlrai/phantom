import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = resolve(here, '..', 'scripts', 'test-ci.mjs');
const progressReporter = pathToFileURL(resolve(here, '..', 'scripts', 'vitest-progress-reporter.mjs')).href;
const roots: string[] = [];
const IDLE_TIMEOUT_FIXTURE_MS = 1_000;
const HARD_TIMEOUT_FIXTURE_MS = 4_000;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runFixture(
  source: string,
  options: { hardMs?: number; idleMs?: number; heartbeatMs?: number; args?: string[]; freeMiB?: number; nodeVersion?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-test-ci-wrapper-'));
  roots.push(root);
  const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  mkdirSync(dirname(vitest), { recursive: true });
  writeFileSync(vitest, source, 'utf8');

  const fixtureWrapper = join(root, 'scripts', 'test-ci.mjs');
  mkdirSync(dirname(fixtureWrapper), { recursive: true });
  // These inert CLIs measure watchdog/forwarding behavior, so give their
  // synthetic host deterministic capacity instead of inheriting host pressure.
  expect(readFileSync(wrapper, 'utf8'), 'Fixture capacity call must match production').toContain('boundedVitestJob(process.env, process.argv.slice(2))');
  writeFileSync(fixtureWrapper, readFileSync(wrapper, 'utf8').replace(
    'const [nodeMajor, nodeMinor]',
    `${options.nodeVersion ? `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(options.nodeVersion)} });` : ''}\nconst [nodeMajor, nodeMinor]`,
  ).replace(
    'boundedVitestJob(process.env, process.argv.slice(2))',
    `boundedVitestJob(process.env, process.argv.slice(2), ${(options.freeMiB ?? 65536) * 1048576}, 8)`,
  ));
  const policy = join(root, 'src', 'core', 'run', 'tool-path.ts');
  mkdirSync(dirname(policy), { recursive: true });
  copyFileSync(resolve(here, '..', 'src', 'core', 'run', 'tool-path.ts'), policy);
  copyFileSync(resolve(here, '..', 'scripts', 'vitest-progress-reporter.mjs'), join(root, 'scripts', 'vitest-progress-reporter.mjs'));

  return spawnSync(process.execPath, [fixtureWrapper, ...(options.args ?? [])], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      ...process.env,
      ASHLR_TEST_CI_TIMEOUT_MS: String(options.hardMs ?? 2_000),
      ASHLR_TEST_CI_IDLE_TIMEOUT_MS: String(options.idleMs ?? 1_000),
      ASHLR_TEST_CI_TERMINATION_GRACE_MS: '100',
      ASHLR_TEST_CI_HEARTBEAT_MS: String(options.heartbeatMs ?? 60_000),
    },
  });
}

describe('test-ci watchdog', () => {
  it.each(['18.18.0', '20.19.0', '22.14.0'])('explains the engine requirement on Node %s', (nodeVersion) => {
    const result = runFixture("console.log('must-not-run')", { nodeVersion });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Node >=22.15.0 is required');
    expect(result.stderr).not.toContain('TypeError');
    expect(result.stdout).not.toContain('must-not-run');
  });

  it('serializes both inline projects under low memory despite larger CLI overrides', () => {
    const result = runFixture(`
      if (process.env.ASHLR_VITEST_UNIT_MAX_WORKERS !== '1') process.exit(8);
      console.log(JSON.stringify(process.argv.slice(2)));
    `, { freeMiB: 512, args: ['--max-workers=20', '--fileParallelism=true'] });
    expect(result.status).toBe(0);
    const argv = JSON.parse(result.stdout.trim()) as string[];
    expect(argv).toContain('--maxWorkers=1');
    expect(argv).toContain('--no-file-parallelism');
    expect(argv).toContain('--pool=forks');
    expect(argv).not.toContain('--fileParallelism=true');
  });

  it('applies the test heap cap and emits a class-labelled RSS receipt on failure', () => {
    const result = runFixture(`
      import { getHeapStatistics } from 'node:v8';
      const heapMiB = getHeapStatistics().heap_size_limit / 1048576;
      if (heapMiB < 1024 || heapMiB > 1152) process.exit(8);
      console.log('heap-cap-ok'); process.exit(7);
    `);
    expect(result.status).toBe(7);
    expect(result.stdout).toContain('heap-cap-ok');
    const receipt = result.stderr.split('\n').find(line => line.startsWith('[job-memory] '));
    expect(receipt).toBeDefined();
    const record = JSON.parse(receipt!.slice('[job-memory] '.length));
    expect(record.jobClass).toBe('test');
    expect(record.peakRssKiB).toBeGreaterThan(0);
    expect(record.pid).toEqual(expect.any(Number));
  });

  it('forwards shard argv without globally disabling project worker budgets', () => {
    const result = runFixture(
      'console.log(JSON.stringify(process.argv.slice(2)));',
      { args: ['--reporter=dot', '--shard=2/3'] },
    );

    expect(result.status).toBe(0);
    const argv = JSON.parse(result.stdout.trim()) as string[];
    expect(argv[0]).toBe('run');
    expect(argv).not.toContain('--no-file-parallelism');
    expect(argv.some((arg) => arg.includes('vitest-progress-reporter.mjs'))).toBe(true);
    expect(argv).toContain('--reporter=dot');
    expect(argv).toContain('--shard=2/3');
    expect(argv).not.toContain('--reporter=default');
  });

  it('preserves an explicit request to serialize a measured subset', () => {
    const result = runFixture(
      'console.log(JSON.stringify(process.argv.slice(2)));',
      { args: ['--maxWorkers=1', '--no-file-parallelism', 'test/native.test.ts'] },
    );

    expect(result.status).toBe(0);
    const argv = JSON.parse(result.stdout.trim()) as string[];
    expect(argv.filter((arg) => arg === '--no-file-parallelism')).toHaveLength(1);
    expect(argv).toContain('--maxWorkers=1');
    expect(argv).toContain('test/native.test.ts');
  });

  it('keeps the default summary alongside compact module progress', () => {
    const result = runFixture('console.log(JSON.stringify(process.argv.slice(2)));');

    const argv = JSON.parse(result.stdout.trim()) as string[];
    expect(argv).toContain('--reporter=default');
    expect(argv.some((arg) => arg.includes('vitest-progress-reporter.mjs'))).toBe(true);
  });

  it('keeps an actively producing process alive past the idle window', () => {
    const result = runFixture(
      `console.log('progress-0');
       let n = 0;
       const timer = setInterval(() => {
         console.log('progress-' + (++n));
         if (n === 5) { clearInterval(timer); process.exit(0); }
       }, 300);`,
      { idleMs: 1_000, hardMs: 3_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('progress-5');
    expect(result.stderr).not.toContain('idle-timeout');
  });

  it('reports bounded actual completion counts without accessing titles or errors', () => {
    const result = runFixture(`
      import AshlrProgressReporter from ${JSON.stringify(progressReporter)};
      let now = 0;
      Object.defineProperty(performance, 'now', { value: () => now });
      const reporter = new AshlrProgressReporter();
      const module = { relativeModuleId: 'test/mission.test.ts', state: () => 'passed' };
      const completed = (state) => ({ module, result: () => ({ state }),
        get name() { throw new Error('Private title accessed'); },
        get fullName() { throw new Error('Private full title accessed'); },
        get errors() { throw new Error('Private error accessed'); } });
      reporter.onTestModuleStart(module);
      now = 30_000; reporter.onTestCaseResult(completed('pending'));
      const first = completed('passed'); reporter.onTestCaseResult(first);
      now = 45_000; reporter.onTestCaseResult(completed('passed'));
      now = 60_000; reporter.onTestCaseResult(completed('failed'));
      now = 90_000; reporter.onTestCaseResult(first);
      reporter.onTestCaseResult(completed('skipped'));
      now = 120_000; reporter.onTestCaseResult(completed('unknown'));
      reporter.onTestModuleEnd(module);
      now = 150_000; reporter.onTestCaseResult(completed('passed'));
    `);

    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    const lines = result.stderr.split(/\r?\n/).filter(line => line.includes('case-completed'));
    expect(lines).toEqual([
      '[test-ci-progress] case-completed state=passed mission.test.ts completed=1',
      '[test-ci-progress] case-completed state=failed mission.test.ts completed=3',
      '[test-ci-progress] case-completed state=skipped mission.test.ts completed=4',
    ]);
    expect(lines.join('\n')).not.toContain('test/');
    expect(result.stderr).not.toContain('Private');
  });

  it('keeps pending-case notifications from concealing an idle child', () => {
    const result = runFixture(`
      import AshlrProgressReporter from ${JSON.stringify(progressReporter)};
      const reporter = new AshlrProgressReporter();
      const module = { relativeModuleId: 'test/pending.test.ts' };
      reporter.onTestModuleStart(module);
      Object.defineProperty(performance, 'now', { value: () => 300_000 });
      reporter.onTestCaseResult({ module, result: () => ({ state: 'pending' }) });
      setTimeout(() => {}, 2_000);
    `, { idleMs: IDLE_TIMEOUT_FIXTURE_MS, hardMs: HARD_TIMEOUT_FIXTURE_MS });

    expect(result.status).toBe(124);
    expect(result.stderr).toContain(`idle-timeout after ${IDLE_TIMEOUT_FIXTURE_MS}ms without output`);
    expect(result.stderr).not.toContain('case-completed');
    expect(result.stderr).not.toContain('hard-runtime-cap reached');
  });

  it('reports liveness without treating its own heartbeat as child output', () => {
    const result = runFixture(
      `setTimeout(() => { console.log('done'); process.exit(0); }, 130);`,
      { idleMs: 500, hardMs: 1_000, heartbeatMs: 25 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('done');
    expect(result.stderr).toContain('[test-ci] heartbeat:');
    expect(result.stderr).toContain('child silent');
    expect(result.stderr).not.toContain('idle-timeout');
  });

  it('reports silence as an idle timeout without claiming a leaked handle', () => {
    const result = runFixture('setTimeout(() => {}, 2_000);', {
      idleMs: IDLE_TIMEOUT_FIXTURE_MS,
      hardMs: HARD_TIMEOUT_FIXTURE_MS,
    });

    expect(result.status).toBe(124);
    expect(result.stderr).toContain(
      `idle-timeout after ${IDLE_TIMEOUT_FIXTURE_MS}ms without output`,
    );
    expect(result.stderr).toContain('not proven leaked handles');
    expect(result.stderr).not.toContain('hard-runtime-cap reached');
  });

  it('does not mistake a colored skipped-file report for an aggregate summary', () => {
    const result = runFixture(
      `console.log('\\x1b[33m↓ |real-io| test/skipped.test.ts (15 tests | 15 skipped)\\x1b[0m');
       console.log('[test-ci-progress] start test/mission.test.ts');
       setTimeout(() => {}, 2_000);`,
      { idleMs: IDLE_TIMEOUT_FIXTURE_MS, hardMs: HARD_TIMEOUT_FIXTURE_MS },
    );

    expect(result.status).toBe(124);
    expect(result.stderr).toContain('not proven leaked handles');
    expect(result.stderr).toContain('start test/mission.test.ts');
    expect(result.stderr).not.toContain('final summary; a leaked handle is plausible');
  });

  it('only identifies possible leaked handles after a final Vitest summary', () => {
    const result = runFixture(
      `console.log('\\x1b[32m Test Files  1 passed (1)\\x1b[0m');
       setTimeout(() => {}, 2_000);`,
      { idleMs: IDLE_TIMEOUT_FIXTURE_MS, hardMs: HARD_TIMEOUT_FIXTURE_MS },
    );

    expect(result.status).toBe(124);
    expect(result.stderr).toContain(
      `idle-timeout after ${IDLE_TIMEOUT_FIXTURE_MS}ms without output`,
    );
    expect(result.stderr).toContain('final summary; a leaked handle is plausible');
  });

  it('reports active work hitting the absolute cap as a runtime-budget failure', () => {
    const result = runFixture(
      `setInterval(() => console.log('still-running'), 30);`,
      // Allow the child to start and emit output even when the release Mac is
      // busy; the contract is which watchdog fires, not a 180 ms deadline.
      { idleMs: 750, hardMs: 2_000 },
    );

    expect(result.status).toBe(124);
    expect(result.stdout).toContain('still-running');
    expect(result.stderr).toContain('hard-runtime-cap reached after 2000ms');
    expect(result.stderr).toContain('not evidence of a leaked handle');
    expect(result.stderr).not.toContain('idle-timeout');
  });

  it.skipIf(process.platform === 'win32')('kills descendants after the leader exits on SIGTERM', () => {
    const descendant = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    const result = runFixture(
      `import { spawn } from 'node:child_process';
       spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });
       process.on('SIGTERM', () => process.exit(0));
       setInterval(() => {}, 1000);`,
      { idleMs: 80, hardMs: 1_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(124);
    expect(result.stderr).toContain('idle-timeout');
  });
});
