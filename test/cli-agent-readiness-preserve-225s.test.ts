/**
 * RQ-PHX-HEADLESSCLIPRESERVE225S — preserves the agent-facing CLI regression
 * suite recovered from PR #929 ("fix(cli): stop plugins enable from prompting
 * when stdin is not a terminal"), original head
 * b613a0f6a1f5a7b1d48f12b46ec3d65759cae07e, source file
 * test/cli-agent-readiness.test.ts.
 *
 * The implementation shipped on master through later work; this file re-proves
 * the contract against CURRENT src/cli/plugins.ts + src/cli/picker.ts:
 *   - plugins enable refuses promptly (exit 2) when stdin is not a terminal,
 *     even with a terminal stdout, and writes no config;
 *   - init/enable/disable --dry-run write nothing;
 *   - re-enable with an unchanged pin and disable of an absent name are
 *     byte-for-byte no-ops reported as already done;
 *   - --json emits the documented success and refusal shapes;
 *   - go/open headless picker failures name the command to re-run, while a
 *     terminal cancel keeps the short line.
 *
 * Adaptation notes vs the original: HOME isolation now uses the H1 fixture
 * (per-test tmp home + homedir() guard) instead of a hand-rolled env swap, and
 * TTY descriptors absent at capture time are deleted on restore rather than
 * left defined. Assertions are unchanged except for the added --json refusal
 * case, which the acceptance slice requires and the original covered only on
 * stderr.
 *
 * Hermetic: fake plugin names under a tmp HOME; no network, credentials,
 * provider calls, or real user config.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdPlugins } from '../src/cli/plugins.js';
import { selectionFailure } from '../src/cli/picker.js';
// Warm the lazily-imported plugin modules at file load: the first dynamic
// import costs seconds under vitest and would blow the 5s unit-lane timeout
// for whichever test happens to run first.
import { _resetPluginCacheForTest } from '../src/core/plugins/registry.js';
import '../src/core/plugins/integrity.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

let fx: H1Fixture;

const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

beforeEach(() => {
  fx = makeFixture();
  _resetPluginCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreTty(process.stdin, stdinTty);
  restoreTty(process.stdout, stdoutTty);
  fx.cleanup();
  _resetPluginCacheForTest();
});

/** Restore an isTTY own-descriptor; when none existed, delete the override. */
function restoreTty(stream: object, original: PropertyDescriptor | undefined): void {
  if (original) Object.defineProperty(stream, 'isTTY', original);
  else delete (stream as { isTTY?: unknown }).isTTY;
}

function capture(): { out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    out.push(parts.map(String).join(' ') + '\n');
  });
  return { out: () => out.join(''), err: () => err.join('') };
}

function setTty(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdin });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdout });
}

function configFile(): string {
  return join(fx.ashlrDir, 'config.json');
}

describe('plugins enable does not prompt when stdin is not a terminal', () => {
  it('returns in under a second when stdout is a terminal and stdin is not', async () => {
    const logs = capture();
    expect(await cmdPlugins(['init', 'demo', '--capability', 'command'])).toBe(0);
    setTty(false, true);
    let timer: NodeJS.Timeout | undefined;
    const started = Date.now();
    const code = await Promise.race([
      cmdPlugins(['enable', 'demo']),
      new Promise<number>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('plugins enable prompted or hung')), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(code).toBe(2);
    expect(logs.err()).toContain('phm plugins enable demo --yes');
    expect(logs.err()).toContain('phm plugins enable demo --dry-run');
    expect(existsSync(configFile())).toBe(false);
  });

  it('refuses with a machine-readable JSON error and writes no config', async () => {
    expect(await cmdPlugins(['init', 'demo', '--capability', 'command'])).toBe(0);
    const logs = capture();
    setTty(false, true);
    expect(await cmdPlugins(['enable', 'demo', '--json'])).toBe(2);
    const body = JSON.parse(logs.out()) as {
      ok: boolean; enabled: boolean; name: string; already: boolean; dryRun: boolean; error: string;
    };
    expect(body).toMatchObject({ ok: false, enabled: false, name: 'demo', already: false, dryRun: false });
    expect(body.error).toContain('phm plugins enable demo --yes');
    expect(logs.err()).toContain('stdin is not a terminal');
    expect(existsSync(configFile())).toBe(false);
  });

  it('enables with --yes and --json when stdin is not a terminal', async () => {
    expect(await cmdPlugins(['init', 'demo', '--capability', 'command'])).toBe(0);
    setTty(false, false);
    const logs = capture();
    expect(await cmdPlugins(['enable', 'demo', '--yes', '--json'])).toBe(0);
    const body = JSON.parse(logs.out()) as {
      ok: boolean; enabled: boolean; name: string; integrity: string; already: boolean; dryRun: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(true);
    expect(body.name).toBe('demo');
    expect(body.already).toBe(false);
    expect(body.dryRun).toBe(false);
    expect(body.integrity).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('plugins --json shapes', () => {
  it('list --json is an array of discovery records', async () => {
    expect(await cmdPlugins(['init', 'demo', '--capability', 'scanner'])).toBe(0);
    const logs = capture();
    expect(await cmdPlugins(['list', '--json'])).toBe(0);
    const body = JSON.parse(logs.out()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      name: 'demo',
      ok: true,
      enabled: false,
      capabilities: ['scanner'],
      version: '0.1.0',
    });
    expect(typeof body[0]?.dir).toBe('string');
  });

  it('info --json is the discovery record', async () => {
    expect(await cmdPlugins(['init', 'demo', '--capability', 'command'])).toBe(0);
    const logs = capture();
    expect(await cmdPlugins(['info', 'demo', '--json'])).toBe(0);
    const body = JSON.parse(logs.out()) as { ok: boolean; manifest: { name: string; entry: string } };
    expect(body.ok).toBe(true);
    expect(body.manifest.name).toBe('demo');
    expect(body.manifest.entry).toBe('./index.mjs');
  });
});

describe('plugins --dry-run writes nothing', () => {
  it('init --dry-run does not create the plugin directory', async () => {
    const logs = capture();
    expect(await cmdPlugins(['init', 'scratch', '--capability', 'scanner', '--dry-run', '--json'])).toBe(0);
    expect(existsSync(join(fx.ashlrDir, 'plugins', 'scratch'))).toBe(false);
    expect(JSON.parse(logs.out())).toMatchObject({
      created: false,
      dryRun: true,
      name: 'scratch',
      capability: 'scanner',
    });
  });

  it('enable --dry-run does not write config', async () => {
    expect(await cmdPlugins(['init', 'demo', '--capability', 'command'])).toBe(0);
    const logs = capture();
    expect(await cmdPlugins(['enable', 'demo', '--dry-run', '--json'])).toBe(0);
    expect(existsSync(configFile())).toBe(false);
    const body = JSON.parse(logs.out()) as { dryRun: boolean; enabled: boolean; already: boolean; name: string };
    expect(body).toMatchObject({ dryRun: true, enabled: true, already: false, name: 'demo' });
  });

  it('disable --dry-run does not rewrite an enabled plugin', async () => {
    expect(await cmdPlugins(['init', 'demo', '--capability', 'command'])).toBe(0);
    expect(await cmdPlugins(['enable', 'demo', '--yes'])).toBe(0);
    const before = readFileSync(configFile());
    const logs = capture();
    expect(await cmdPlugins(['disable', 'demo', '--dry-run', '--json'])).toBe(0);
    expect(readFileSync(configFile()).equals(before)).toBe(true);
    expect(JSON.parse(logs.out())).toMatchObject({
      ok: true, enabled: false, name: 'demo', already: false, dryRun: true,
    });
  });
});

describe('plugins enable and disable are idempotent', () => {
  it('a second enable with the same pin does not rewrite config', async () => {
    expect(await cmdPlugins(['init', 'demo', '--capability', 'command'])).toBe(0);
    expect(await cmdPlugins(['enable', 'demo', '--yes'])).toBe(0);
    const before = readFileSync(configFile());
    const logs = capture();
    expect(await cmdPlugins(['enable', 'demo', '--yes', '--json'])).toBe(0);
    expect(readFileSync(configFile()).equals(before)).toBe(true);
    expect(JSON.parse(logs.out())).toMatchObject({
      ok: true, enabled: true, name: 'demo', already: true, dryRun: false,
    });
  });

  it('disable of a plugin that is not enabled exits 0 and writes nothing', async () => {
    const logs = capture();
    expect(await cmdPlugins(['disable', 'missing', '--json'])).toBe(0);
    expect(existsSync(configFile())).toBe(false);
    expect(JSON.parse(logs.out())).toMatchObject({
      ok: true, enabled: false, name: 'missing', already: true, dryRun: false,
    });
  });
});

describe('go and open headless picker failures', () => {
  it('names the command when there is no query', () => {
    expect(selectionFailure('go', { headless: true, query: '', itemCount: 3 })).toEqual({
      message: [
        'Nothing selected. stdin is not a terminal, so the picker did not run.',
        '  Re-run: phm go <name>',
        '  Print a path: phm go <name> --cd',
      ].join('\n'),
      code: 2,
    });
    expect(selectionFailure('open', { headless: true, query: '', itemCount: 3 }).code).toBe(2);
    expect(selectionFailure('open', { headless: true, query: '', itemCount: 3 }).message).toContain('phm open <name>');
  });

  it('keeps the short line when the caller cancelled on a terminal', () => {
    expect(selectionFailure('go', { headless: false, query: '', itemCount: 3 })).toEqual({
      message: 'Nothing selected.',
      code: 1,
    });
  });

  it('points an empty index at phm status', () => {
    const failure = selectionFailure('open', { headless: true, query: '', itemCount: 0 });
    expect(failure.code).toBe(1);
    expect(failure.message).toContain('Nothing selected.');
    expect(failure.message).toContain('phm status');
  });
});
