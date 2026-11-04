/**
 * Registry-wide `--help` smoke test for `ashlr fleet <verb>`.
 *
 * More than a hundred fleet verbs were merged independently, each without a
 * full-suite check that the verb even loads and answers `--help` without
 * throwing. This suite walks every key in FLEET_SUBCOMMAND_LOADERS, resolves
 * the exported `cmdFleet<PascalName>` through the same convention the
 * dispatcher uses (resolveFleetSubcommand), and calls it with `['--help']`.
 *
 * Per verb it asserts:
 *   - the lazy loader resolves (no import-time crash; bounded separately at
 *     LOAD_BUDGET_MS because first-import module transform is one-time I/O,
 *     not the verb's answer),
 *   - the dispatch export exists and is a function,
 *   - the call neither throws nor rejects and settles inside CALL_BUDGET_MS
 *     (5 s per verb),
 *   - it returns a number or undefined (the dispatcher `return await`s it),
 *   - it printed text to stdout or stderr (0 and 2 are both fine exits),
 *   - it did not spawn a child process or call process.exit on the help path.
 *
 * Isolation: HOME/ASHLR_HOME/ASHLR_RUNS_DIR point at a fresh mkdtemp per verb,
 * global fetch is stubbed to reject, and every child_process spawn surface is
 * a throwing spy — no verb can touch ~/.ashlr-runs, the network or `gh`.
 *
 * Warm-up: a few verbs transitively pull the console API graph (~40 s of
 * transform on a cold cache). beforeAll resolves every loader once, in
 * parallel, under the same env and fetch isolation; rejections stay cached in
 * the module registry and surface in the verb's own `it`, while a loader
 * still pending after WARM_LOAD_DEADLINE_MS gets one more bounded window
 * (LOAD_BUDGET_MS) inside its `it`.
 *
 * KNOWN_HELP_FAILURES lists verbs whose `--help` is still broken and is run
 * with `it.fails`: when one gets fixed the inverted assertion fails and the
 * entry must come out, so the list can only shrink. Remove an entry in the
 * same PR that fixes the verb.
 */
import * as childProcess from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

// Any child-process launch on the --help path is a bug: the mocks record the
// attempt and throw so nothing real is spawned (no `gh`, no daemon probes).
vi.mock('node:child_process', async importOriginal => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  const blocked = (name: string) => vi.fn(() => {
    throw new Error(`fleet ${name} may not spawn a child process on --help`);
  });
  return {
    ...mod,
    spawn: blocked('spawn'),
    spawnSync: blocked('spawnSync'),
    exec: blocked('exec'),
    execSync: blocked('execSync'),
    execFile: blocked('execFile'),
    execFileSync: blocked('execFileSync'),
    fork: blocked('fork'),
  };
});

const CHILD_SPAWN_SPIES = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
/** The `--help` call itself: five seconds per verb, as ordered. */
const CALL_BUDGET_MS = 5_000;
/** Bounded window for a loader the warm-up pass left in flight (transform residue). */
const LOAD_BUDGET_MS = 30_000;
/** One loader may stall only this long during warm-up before its `it` owns the wait. */
const WARM_LOAD_DEADLINE_MS = 150_000;
/** Whole warm-up pass: cold transform of the full graph plus slow-host headroom. */
const WARM_UP_BUDGET_MS = 300_000;
/** Hard ceiling on each `it`: load budget + call budget + assertion overhead. */
const VERB_TEST_TIMEOUT_MS = 45_000;

/**
 * Verbs whose `--help` is still broken, one comment each for the next pass.
 * Keyed entries run under `it.fails`; a verb that starts passing must be
 * removed here in the same change.
 */
const KNOWN_HELP_FAILURES = new Set<string>([
]);

let root = '';
const printed: string[] = [];
const exitCalls: Array<number | string | null | undefined> = [];

const delay = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

beforeAll(async () => {
  const warmRoot = await mkdtemp(join(tmpdir(), 'fleet-verb-help-warm-'));
  vi.stubEnv('HOME', warmRoot);
  vi.stubEnv('ASHLR_HOME', join(warmRoot, '.ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(warmRoot, '.ashlr-runs'));
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('fleet-verb-help-smoke: network access is disabled');
  }));
  try {
    await Promise.all(Object.values(FLEET_SUBCOMMAND_LOADERS).map(loader =>
      Promise.race([Promise.resolve().then(() => loader()), delay(WARM_LOAD_DEADLINE_MS)]).then(
        () => undefined,
        () => undefined,
      ),
    ));
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(warmRoot, { recursive: true, force: true });
  }
}, WARM_UP_BUDGET_MS);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet-verb-help-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('fleet-verb-help-smoke: network access is disabled');
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  printed.length = 0;
  exitCalls.length = 0;
  await rm(root, { recursive: true, force: true });
});

function installOutputSpies(): void {
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });
  }
  // The write(chunk, [encoding,] callback) form must run its callback:
  // several verbs await a drain promise that never resolves otherwise.
  const captureWrite = (chunk: unknown, ...rest: unknown[]): boolean => {
    printed.push(typeof chunk === 'string' ? chunk : String(chunk));
    const done = rest.find((arg): arg is (error?: Error | null) => void => typeof arg === 'function');
    done?.(null);
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(captureWrite as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(captureWrite as typeof process.stderr.write);
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    exitCalls.push(code);
    return undefined as never;
  });
}

const TIMED_OUT = Symbol('timed-out');

async function bounded<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([work.then(value => value as T | typeof TIMED_OUT, err => { throw err; }), delay(ms).then(() => TIMED_OUT)]);
}

async function runFleetVerbHelp(verb: string): Promise<void> {
  const resolved = resolveFleetSubcommand(verb);
  expect(resolved, `registry key ${JSON.stringify(verb)} does not satisfy the fleet-<name> naming rule`).not.toBeNull();
  const loader = FLEET_SUBCOMMAND_LOADERS[verb];
  expect(typeof loader, `no loader registered for ${verb}`).toBe('function');

  installOutputSpies();

  // The loader itself must resolve: an import-time crash is exactly the
  // failure this suite exists to catch.
  const loaded = await bounded(loader!(), LOAD_BUDGET_MS);
  expect(loaded, `fleet ${verb} loader did not resolve within ${LOAD_BUDGET_MS}ms`).not.toBe(TIMED_OUT);
  const fn = (loaded as Record<string, unknown>)?.[resolved!.exportName];
  expect(typeof fn, `${verb} must export ${resolved!.exportName} for the dispatcher`).toBe('function');

  // Only output produced by the call counts: a module that prints at import
  // time cannot satisfy "answers --help".
  printed.length = 0;

  const previousExitCode = process.exitCode;
  let result: unknown;
  try {
    result = await bounded(
      Promise.resolve((fn as (args: string[]) => Promise<number> | number)(['--help'])),
      CALL_BUDGET_MS,
    );
  } finally {
    process.exitCode = previousExitCode;
  }

  expect(result, `fleet ${verb} --help did not settle within ${CALL_BUDGET_MS}ms`).not.toBe(TIMED_OUT);
  expect(
    result === undefined || typeof result === 'number',
    `fleet ${verb} --help returned ${typeof result}; the dispatcher expects a number or undefined`,
  ).toBe(true);
  expect(printed.join('').trim().length, `fleet ${verb} --help printed nothing`).toBeGreaterThan(0);
  expect(exitCalls, `fleet ${verb} --help called process.exit(${exitCalls.join(', ')}) instead of returning`).toHaveLength(0);
  for (const name of CHILD_SPAWN_SPIES) {
    expect(childProcess[name], `fleet ${verb} --help spawned a child process via ${name}`).not.toHaveBeenCalled();
  }
}

const registryVerbs = Object.keys(FLEET_SUBCOMMAND_LOADERS);

describe('fleet verb --help smoke', () => {
  it('every KNOWN_HELP_FAILURES entry still names a registered verb', () => {
    for (const verb of KNOWN_HELP_FAILURES) {
      expect(registryVerbs, `KNOWN_HELP_FAILURES lists unregistered verb ${verb}`).toContain(verb);
    }
  });

  for (const verb of registryVerbs) {
    if (KNOWN_HELP_FAILURES.has(verb)) {
      it.fails(`fleet ${verb} --help (known failure)`, () => runFleetVerbHelp(verb), VERB_TEST_TIMEOUT_MS);
    } else {
      it(`fleet ${verb} --help`, () => runFleetVerbHelp(verb), VERB_TEST_TIMEOUT_MS);
    }
  }
});
