import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_ENV_MARKERS, ownerConfigPath } from '../src/core/teams/identity.js';
import { appendEvent } from '../src/core/teams/index.js';
import { cmdTeam } from '../src/cli/team.js';

const T = 'cli-json-test';
const owner = { kind: 'human' as const, id: 'human:owner' };
let home: string;
const asHuman = (name: string) => writeFileSync(ownerConfigPath(), JSON.stringify({ human: name }));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'team-cli-json-'));
  vi.stubEnv('ASHLR_HOME', home);
  for (const marker of AGENT_ENV_MARKERS) vi.stubEnv(marker, '');
  mkdirSync(dirname(ownerConfigPath()), { recursive: true });
  asHuman('owner');
  appendEvent(T, owner, 'member.joined', {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

const envelope = (raw: unknown) => {
  const env = JSON.parse(String(raw));
  expect(env).toMatchObject({ schema: 'phantom.team.v1', version: 1 });
  expect(typeof env.error).toBe('string');
  expect(typeof env.refused).toBe('boolean');
  return env as { error: string; refused: boolean };
};

describe('phm team --json failures', () => {
  it('answers a bad invite with the parseable envelope on stderr, not stdout', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdTeam(['join', 'garbage', '--team', T, '--json'])).toBe(1);
    expect(log).not.toHaveBeenCalled();
    const env = envelope(err.mock.calls.at(-1)?.[0]);
    expect(env.error).toMatch(/Not a valid invite/);
    expect(env.refused).toBe(false);
  });

  it('answers an agent-process refusal with the envelope', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdTeam(['join', '--team', T, '--json'])).toBe(1);
    const env = envelope(err.mock.calls.at(-1)?.[0]);
    expect(env.error).toMatch(/agent process/);
    expect(env.refused).toBe(false);
  });

  it('answers an unknown verb with the envelope and exit 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdTeam(['bogus', '--json'])).toBe(2);
    const env = envelope(err.mock.calls.at(-1)?.[0]);
    expect(env.error).toMatch(/Unknown team command 'bogus'/);
    expect(env.refused).toBe(false);
  });

  it('answers an arg-count usage error with the envelope and exit 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdTeam(['invite', '--json'])).toBe(2);
    const env = envelope(err.mock.calls.at(-1)?.[0]);
    expect(env.error).toBe('Invalid arguments. Run: phm team --help');
    expect(env.refused).toBe(false);
  });

  it('keeps the directory masking and refused flag for person verbs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdTeam(['show', 'person:ghost', '--team', T, '--json'])).toBe(1);
    expect(envelope(err.mock.calls.at(-1)?.[0]).error).toMatch(/Teammate not found/);
    expect(await cmdTeam(['remove', 'human:owner', '--team', T, '--json'])).toBe(1);
    const env = envelope(err.mock.calls.at(-1)?.[0]);
    expect(env.error).toMatch(/last owner cannot be removed/);
    expect(env.refused).toBe(true);
  });

  it('prints plain-text errors unchanged without --json', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdTeam(['join', 'garbage', '--team', T])).toBe(1);
    const text = String(err.mock.calls.at(-1)?.[0]);
    expect(text).toMatch(/^phm team: Not a valid invite/);
    expect(text).not.toMatch(/^\{/);
    expect(await cmdTeam(['invite', '--team', T])).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0])).toMatch(/^phm team: Usage: phm team/);
  });
});

describe('phm team help and join hints', () => {
  it.each([['--help'], ['-h'], ['help'], ['view', '--help']])('prints usage and exits 0 for %j', async (...argv) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdTeam(argv)).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/Usage: phm team/);
  });

  it('points a fresh joiner at view', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdTeam(['join', '--team', T])).toBe(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain(`Next: phm team view --team ${T}`);
  });
});
