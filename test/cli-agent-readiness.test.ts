/**
 * Agent-facing CLI gaps fixed with the readiness audit.
 *
 * plugins enable must return when stdin is not a terminal, even if stdout is.
 * --dry-run on init, enable and disable must not create or rewrite files.
 * --json shapes below are the ones docs/CLI-AGENT-READINESS.md names.
 * go/open headless picker failures name the command to run.
 *
 * Hermetic: HOME is a temp directory for the plugin cases. No network.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdPlugins } from '../src/cli/plugins.js';
import { selectionFailure } from '../src/cli/picker.js';

const homes: string[] = [];
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

afterEach(() => {
  vi.restoreAllMocks();
  if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
  if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ASHLR_HOME: process.env.ASHLR_HOME,
  };
  const home = mkdtempSync(join(tmpdir(), 'phm-agent-cli-'));
  homes.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  try {
    return await run(home);
  } finally {
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    if (prev.ASHLR_HOME === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = prev.ASHLR_HOME;
  }
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

function configPath(home: string): string {
  return join(home, '.ashlr', 'config.json');
}

describe('plugins enable does not prompt when stdin is not a terminal', () => {
  it('returns in under a second when stdout is a terminal and stdin is not', async () => {
    await withHome(async (home) => {
      const logs = capture();
      expect(await cmdPlugins(['init', 'demo', '--capability', 'command'])).toBe(0);
      // The first registry import is a cold module load. Warm it so the
      // timer measures the consent gate, which must not wait on a prompt.
      await import('../src/core/plugins/registry.js');
      await import('../src/core/plugins/integrity.js');
      setTty(false, true);
      const started = Date.now();
      const code = await Promise.race([
        cmdPlugins(['enable', 'demo']),
        new Promise<number>((_resolve, reject) => {
          setTimeout(() => reject(new Error('plugins enable prompted or hung')), 1000);
        }),
      ]);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(code).toBe(2);
      expect(logs.err()).toContain('phm plugins enable demo --yes');
      expect(logs.err()).toContain('phm plugins enable demo --dry-run');
      expect(existsSync(configPath(home))).toBe(false);
    });
  });

  it('enables with --yes and --json when stdin is not a terminal', async () => {
    await withHome(async () => {
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
});

describe('plugins --json shapes', () => {
  it('list --json is an array of discovery records', async () => {
    await withHome(async () => {
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
  });

  it('info --json is the discovery record', async () => {
    await withHome(async () => {
      expect(await cmdPlugins(['init', 'demo', '--capability', 'command'])).toBe(0);
      const logs = capture();
      expect(await cmdPlugins(['info', 'demo', '--json'])).toBe(0);
      const body = JSON.parse(logs.out()) as { ok: boolean; manifest: { name: string; entry: string } };
      expect(body.ok).toBe(true);
      expect(body.manifest.name).toBe('demo');
      expect(body.manifest.entry).toBe('./index.mjs');
    });
  });
});

describe('plugins --dry-run writes nothing', () => {
  it('init --dry-run does not create the plugin directory', async () => {
    await withHome(async (home) => {
      const logs = capture();
      expect(await cmdPlugins(['init', 'scratch', '--capability', 'scanner', '--dry-run', '--json'])).toBe(0);
      expect(existsSync(join(home, '.ashlr', 'plugins', 'scratch'))).toBe(false);
      expect(JSON.parse(logs.out())).toMatchObject({
        created: false,
        dryRun: true,
        name: 'scratch',
        capability: 'scanner',
      });
    });
  });

  it('enable --dry-run does not write config', async () => {
    await withHome(async (home) => {
      expect(await cmdPlugins(['init', 'demo', '--capability', 'command'])).toBe(0);
      const logs = capture();
      expect(await cmdPlugins(['enable', 'demo', '--dry-run', '--json'])).toBe(0);
      expect(existsSync(configPath(home))).toBe(false);
      const body = JSON.parse(logs.out()) as { dryRun: boolean; enabled: boolean; already: boolean; name: string };
      expect(body).toMatchObject({ dryRun: true, enabled: true, already: false, name: 'demo' });
    });
  });

  it('disable --dry-run does not rewrite an enabled plugin', async () => {
    await withHome(async (home) => {
      expect(await cmdPlugins(['init', 'demo', '--capability', 'command'])).toBe(0);
      expect(await cmdPlugins(['enable', 'demo', '--yes'])).toBe(0);
      const before = readFileSync(configPath(home));
      const logs = capture();
      expect(await cmdPlugins(['disable', 'demo', '--dry-run', '--json'])).toBe(0);
      expect(readFileSync(configPath(home)).equals(before)).toBe(true);
      expect(JSON.parse(logs.out())).toMatchObject({
        ok: true, enabled: false, name: 'demo', already: false, dryRun: true,
      });
    });
  });
});

describe('plugins enable and disable are idempotent', () => {
  it('a second enable with the same pin does not rewrite config', async () => {
    await withHome(async (home) => {
      expect(await cmdPlugins(['init', 'demo', '--capability', 'command'])).toBe(0);
      expect(await cmdPlugins(['enable', 'demo', '--yes'])).toBe(0);
      const before = readFileSync(configPath(home));
      const logs = capture();
      expect(await cmdPlugins(['enable', 'demo', '--yes', '--json'])).toBe(0);
      expect(readFileSync(configPath(home)).equals(before)).toBe(true);
      expect(JSON.parse(logs.out())).toMatchObject({
        ok: true, enabled: true, name: 'demo', already: true, dryRun: false,
      });
    });
  });

  it('disable of a plugin that is not enabled exits 0 and writes nothing', async () => {
    await withHome(async (home) => {
      const logs = capture();
      expect(await cmdPlugins(['disable', 'missing', '--json'])).toBe(0);
      expect(existsSync(configPath(home))).toBe(false);
      expect(JSON.parse(logs.out())).toMatchObject({
        ok: true, enabled: false, name: 'missing', already: true, dryRun: false,
      });
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
