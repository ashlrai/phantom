/**
 * RQ-PHX-RECUTCOREO1S136 — regression coverage for the behavior recovered
 * from PR #929 ("fix(cli): stop plugins enable from prompting when stdin is
 * not a terminal"):
 *
 *   - `plugins enable <name>` without --yes never prompts on a non-terminal
 *     stdin: it exits 2 and names `phm plugins enable <name> --yes`.
 *   - `init`, `enable` and `disable` accept --dry-run and write nothing.
 *   - Re-enable of an unchanged pin reports already enabled; disable of a
 *     name that is not enabled reports already disabled (both exit 0).
 *   - `go` / `open` headless failures name the command to re-run
 *     (picker.selectionFailure).
 *
 * Hermetic: tmp HOME per test (h1-fixture) so plugin dirs are disposable;
 * config writes land in the run-relocated CONFIG_PATH and are reset after
 * each test, matching the m33 plugin suites.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { cmdPlugins } from '../src/cli/plugins.js';
import { selectionFailure } from '../src/cli/picker.js';
import { loadConfigReadOnly, saveConfig } from '../src/core/config.js';
import { _resetPluginCacheForTest } from '../src/core/plugins/registry.js';

let fx: H1Fixture;
let outText = '';
let errText = '';
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origLog = console.log;

beforeEach(() => {
  fx = makeFixture();
  _resetPluginCacheForTest();
  outText = '';
  errText = '';
  process.stdout.write = ((chunk: unknown) => {
    outText += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errText += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  console.log = (...args: unknown[]) => {
    outText += args.map(String).join(' ') + '\n';
  };
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  console.log = origLog;
  saveConfig(makeCfg());
  _resetPluginCacheForTest();
  fx.cleanup();
});

/** Scaffold a real plugin under the fixture's ~/.ashlr/plugins/. */
async function scaffold(name: string): Promise<string> {
  expect(await cmdPlugins(['init', name, '--capability', 'scanner'])).toBe(0);
  outText = '';
  errText = '';
  return join(fx.ashlrDir, 'plugins', name);
}

const enabled = () => loadConfigReadOnly().plugins?.enabled ?? [];

describe('plugins enable on a non-terminal stdin (PR #929)', () => {
  it('exits 2 without prompting and names the --yes command', async () => {
    await scaffold('cap-one');
    // vitest stdin is not a TTY: enable must refuse rather than read a pipe.
    expect(process.stdin.isTTY).toBeFalsy();
    expect(await cmdPlugins(['enable', 'cap-one'])).toBe(2);
    expect(errText).toContain('stdin is not a terminal');
    expect(errText).toContain('phm plugins enable cap-one --yes');
    expect(enabled()).toEqual([]);
  });

  it('emits one JSON refusal on stdout under --json and still exits 2', async () => {
    await scaffold('cap-two');
    expect(await cmdPlugins(['enable', 'cap-two', '--json'])).toBe(2);
    const parsed = JSON.parse(outText) as { ok: boolean; enabled: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.enabled).toBe(false);
    expect(parsed.error).toContain('phm plugins enable cap-two --yes');
    expect(enabled()).toEqual([]);
  });

  it('--dry-run reports the pin and writes nothing', async () => {
    await scaffold('cap-three');
    expect(await cmdPlugins(['enable', 'cap-three', '--dry-run'])).toBe(0);
    expect(outText).toContain('dry-run: would enable cap-three');
    expect(outText).toContain('phm plugins enable cap-three --yes');
    expect(enabled()).toEqual([]);
  });

  it('re-enable of an unchanged pin reports already enabled and does not rewrite', async () => {
    await scaffold('cap-four');
    expect(await cmdPlugins(['enable', 'cap-four', '--yes'])).toBe(0);
    const pin = loadConfigReadOnly().plugins?.integrity?.['cap-four'];
    expect(enabled()).toEqual(['cap-four']);
    expect(pin).toMatch(/^sha256:/);

    outText = '';
    errText = '';
    expect(await cmdPlugins(['enable', 'cap-four', '--yes'])).toBe(0);
    expect(outText).toContain('already enabled cap-four');
    expect(loadConfigReadOnly().plugins?.integrity?.['cap-four']).toBe(pin);
    expect(enabled()).toEqual(['cap-four']);
  });
});

describe('plugins disable (PR #929)', () => {
  it('disable of a name that is not enabled reports already disabled and exits 0', async () => {
    expect(await cmdPlugins(['disable', 'never-on'])).toBe(0);
    expect(outText).toContain('already disabled never-on');
    expect(errText).not.toContain('error:');
  });

  it('disable --dry-run writes nothing and leaves the plugin enabled', async () => {
    saveConfig(makeCfg({
      plugins: { enabled: ['stay-on'], settings: {}, integrity: { 'stay-on': 'sha256:pin' } },
    }));
    expect(await cmdPlugins(['disable', 'stay-on', '--dry-run'])).toBe(0);
    expect(outText).toContain('dry-run: would disable stay-on');
    expect(enabled()).toEqual(['stay-on']);
  });
});

describe('plugins init --dry-run (PR #929)', () => {
  it('writes nothing and names the real command', async () => {
    expect(await cmdPlugins(['init', 'ghost-plugin', '--dry-run'])).toBe(0);
    expect(outText).toContain('dry-run: would scaffold ghost-plugin');
    expect(outText).toContain('phm plugins init ghost-plugin');
    expect(existsSync(join(fx.ashlrDir, 'plugins', 'ghost-plugin'))).toBe(false);
  });
});

describe('selectionFailure (go / open headless picker)', () => {
  it('keeps the short line for a terminal cancel', () => {
    expect(selectionFailure('go', { headless: false, query: '', itemCount: 4 }))
      .toEqual({ message: 'Nothing selected.', code: 1 });
  });

  it('headless with no query names the command to re-run (exit 2)', () => {
    const f = selectionFailure('go', { headless: true, query: '', itemCount: 4 });
    expect(f.code).toBe(2);
    expect(f.message).toContain('stdin is not a terminal');
    expect(f.message).toContain('phm go <name>');
    const o = selectionFailure('open', { headless: true, query: '', itemCount: 4 });
    expect(o.code).toBe(2);
    expect(o.message).toContain('phm open <name>');
  });

  it('headless with an ambiguous query says the query matched more than one', () => {
    const f = selectionFailure('go', { headless: true, query: 'docs', itemCount: 4 });
    expect(f.code).toBe(1);
    expect(f.message).toContain('"docs" matched more than one item');
    expect(f.message).toContain('phm go <name> --cd');
  });

  it('headless with an empty index points at phm status', () => {
    const f = selectionFailure('open', { headless: true, query: '', itemCount: 0 });
    expect(f.code).toBe(1);
    expect(f.message).toContain('phm status');
  });
});
