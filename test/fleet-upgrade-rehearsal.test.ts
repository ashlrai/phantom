import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FLEET_REHEARSAL_VERBS,
  daemonStateFixtureIssues,
  outputReportsUnreadable,
  parseRehearsalArgs,
  rehearsalEnv,
  runFleetUpgradeRehearsal,
  seedOldHome,
  stderrHasStackTrace,
} from '../scripts/fleet-upgrade-rehearsal.mjs';

interface FakeResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

type FakeRunner = (cli: string, argv: string[], opts: { env: Record<string, string>; cwd: string; timeoutMs: number }) => FakeResult;

const ok: FakeResult = { status: 0, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: null };

function fakeRunner(overrides: Record<string, Partial<FakeResult>>): FakeRunner {
  return (_cli, argv) => {
    const name = argv.join(' ');
    const result = { ...ok, ...(overrides[name] ?? {}) };
    return result;
  };
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'phx-rehearsal-'));
}

async function rehearse(runner: FakeRunner, home = tempHome()) {
  return runFleetUpgradeRehearsal({ home, runner });
}

describe('fleet-upgrade-rehearsal fixtures', () => {
  it('seeds the three old-shaped state files under the temp home only', () => {
    const home = tempHome();
    const seeded = seedOldHome(home);
    expect(seeded).toHaveLength(6);
    for (const path of seeded) {
      expect(path.startsWith(home)).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
    const config = JSON.parse(readFileSync(join(home, '.ashlr', 'config.json'), 'utf8'));
    expect(config.version).toBe(1);
    expect(config.foundry.allowedBackends).toEqual(['builtin']);
    const daemon = JSON.parse(readFileSync(join(home, '.ashlr', 'daemon.json'), 'utf8'));
    expect(daemonStateFixtureIssues(daemon)).toEqual([]);
    expect(daemon.running).toBe(true);
    const fleet = JSON.parse(readFileSync(join(home, '.ashlr', 'fleet', 'fleet.json'), 'utf8'));
    expect(fleet.v).toBe(1);
    expect(fleet.repos[0].repo).toBe('ashlrai/phantom');
    expect(fleet.holds[0].kind).toBe('owner-hold');
  });

  it('marks a daemon.json that misses v3.29.15-era required fields unreadable', async () => {
    const home = tempHome();
    const report = await runFleetUpgradeRehearsal({
      home,
      runner: () => ok,
      seed: (target) => {
        const seeded = seedOldHome(target);
        writeFileSync(join(target, '.ashlr', 'daemon.json'), JSON.stringify({ running: true }));
        return seeded;
      },
    });
    expect(report.ok).toBe(false);
    const daemon = report.stateFiles.find((f) => f.name === 'daemon.json');
    expect(daemon?.readable).toBe(false);
    expect(report.failures.some((f) => f.includes('daemon.json'))).toBe(true);
  });
});

describe('runFleetUpgradeRehearsal', () => {
  it('passes when every verb finishes inside its contract', async () => {
    const report = await rehearse(fakeRunner({ 'local-runtime status': { status: 1 } }));
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.verbs).toHaveLength(FLEET_REHEARSAL_VERBS.length);
    const runtime = report.verbs.find((v) => v.verb === 'local-runtime status');
    expect(runtime?.exitCode).toBe(1);
    expect(runtime?.crashed).toBe(false);
  });

  it('fails when one verb crashes (unexpected nonzero exit)', async () => {
    const report = await rehearse(fakeRunner({
      'fleet status --json': { status: 1, stderr: 'error: failed to build fleet status: daemon-state-malformed\n' },
    }));
    expect(report.ok).toBe(false);
    const verb = report.verbs.find((v) => v.verb === 'fleet status --json');
    expect(verb?.crashed).toBe(true);
    expect(report.failures.some((f) => f.includes('fleet status --json'))).toBe(true);
  });

  it('fails when one verb times out', async () => {
    const report = await rehearse(fakeRunner({
      'resources --json': { status: null, signal: 'SIGKILL', timedOut: true },
    }));
    expect(report.ok).toBe(false);
    const verb = report.verbs.find((v) => v.verb === 'resources --json');
    expect(verb?.timedOut).toBe(true);
    expect(verb?.crashed).toBe(true);
  });

  it('fails when stderr holds a stack trace even on exit 0', async () => {
    const report = await rehearse(fakeRunner({
      'fleet brains --json': {
        status: 0,
        stderr: 'Error: bridged record exploded\n    at readFleetBrains (file:///tmp/x.js:12:34)\n',
      },
    }));
    expect(report.ok).toBe(false);
    const verb = report.verbs.find((v) => v.verb === 'fleet brains --json');
    expect(verb?.stackTrace).toBe(true);
    expect(verb?.crashed).toBe(true);
  });

  it('fails when a verb reports an old state file unreadable', async () => {
    const report = await rehearse(fakeRunner({
      'fleet status --json': { stdout: '{"daemon":{"sourceQuality":{"reason":"unreadable"}}}' },
    }));
    expect(report.ok).toBe(false);
    const verb = report.verbs.find((v) => v.verb === 'fleet status --json');
    expect(verb?.stateUnreadable).toBe(true);
    expect(verb?.crashed).toBe(false);
  });
});

describe('detectors', () => {
  it('does not call a plain CLI error line a stack trace', () => {
    expect(stderrHasStackTrace('error: failed to load config.\n')).toBe(false);
    expect(stderrHasStackTrace('')).toBe(false);
  });

  it('detects real stack frames and uncaught banners', () => {
    expect(stderrHasStackTrace('TypeError: x\n    at f (file:///a/b.js:1:2)\n')).toBe(true);
    expect(stderrHasStackTrace('    at async g (file:///a/b.js:10:20)\n')).toBe(true);
    expect(stderrHasStackTrace('Uncaught Error\n')).toBe(true);
  });

  it('matches loader unreadable vocabulary but not counters or absence prose', () => {
    expect(outputReportsUnreadable('{"malformedLines":0}', '')).toBe(false);
    expect(outputReportsUnreadable('{"unreadableFiles":0}', '')).toBe(false);
    expect(outputReportsUnreadable('{"detail":"persisted backlog snapshot is missing or unreadable"}', '')).toBe(false);
    expect(outputReportsUnreadable('{"detail":"Post-merge evidence is missing, degraded, incomplete, or malformed."}', '')).toBe(false);
    expect(outputReportsUnreadable('{"reason":"unreadable"}', '')).toBe(true);
    expect(outputReportsUnreadable('{"reason":"malformed"}', '')).toBe(true);
    expect(outputReportsUnreadable('{"reasons":["proposals-unreadable"]}', '')).toBe(true);
    expect(outputReportsUnreadable('', 'daemon state failed strict validation: daemon-state-malformed\n')).toBe(true);
    expect(outputReportsUnreadable('', '[ashlr] Warning: config file at /x/config.json is not valid JSON: bad. Using defaults.\n')).toBe(true);
  });
});

describe('parseRehearsalArgs', () => {
  it('requires --home', () => {
    expect(() => parseRehearsalArgs([])).toThrow('--home');
    expect(() => parseRehearsalArgs(['--home', 'relative/dir'])).toThrow('absolute');
  });

  it('refuses the real home directory', () => {
    const realHome = process.env.HOME;
    expect(realHome).toBeTruthy();
    expect(() => parseRehearsalArgs(['--home', realHome!])).toThrow('real home');
  });

  it('accepts an absolute temp home and --json', () => {
    const parsed = parseRehearsalArgs(['--home', tempHome(), '--json']);
    expect(parsed.json).toBe(true);
    expect(parsed.help).toBe(false);
  });
});

describe('rehearsalEnv', () => {
  it('never forwards credential, token or provider variables to the verbs', () => {
    const env = rehearsalEnv(tempHome());
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/token|secret|key(?!name)|credential|oauth/i);
    }
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ASHLR_VERSION).toBeUndefined();
    expect(env.PHANTOM_FLEET_PATH).toBeUndefined();
    expect(env.OLLAMA_BASE_URL).toBeUndefined();
  });

  it('pins every home-resolved store under the temp home', () => {
    const home = tempHome();
    const env = rehearsalEnv(home);
    expect(env.HOME).toBe(home);
    expect(env.ASHLR_HOME).toBe(join(home, '.ashlr'));
    expect(env.ASHLR_RUNS_DIR).toBe(join(home, '.ashlr-runs'));
    expect(env.CODEX_HOME).toBe(join(home, '.codex'));
    expect(env.CODEX_HOME_ALT).toBe(join(home, '.codex-2'));
  });
});
