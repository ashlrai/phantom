/**
 * `phm team <verb> --help` and `-h` print usage and exit 0 without acting.
 *
 * The dispatcher used to treat the flag as an operand: `team say --help`
 * posted "--help" to the channel and `team join --help` enrolled the local
 * human. test/cli-help-no-side-effects now enumerates every team verb (they
 * are in the completions table), and this file pins the no-side-effect
 * contract at the unit level for the two verbs that write.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_ENV_MARKERS, ownerConfigPath } from '../src/core/teams/identity.js';
import { teamState } from '../src/core/teams/index.js';
import { cmdTeam } from '../src/cli/team.js';

const T = 'help-test';
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'team-help-'));
  vi.stubEnv('ASHLR_HOME', home);
  for (const marker of AGENT_ENV_MARKERS) vi.stubEnv(marker, '');
  mkdirSync(dirname(ownerConfigPath()), { recursive: true });
  writeFileSync(ownerConfigPath(), JSON.stringify({ human: 'owner' }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
  const code = await cmdTeam(argv);
  return { code, out: lines.join('\n') };
}

describe('team --help prints usage and never acts', () => {
  it('bare and per-verb help exit 0 with the usage text', async () => {
    for (const argv of [['--help'], ['-h'], ['view', '--help'], ['say', '-h'], ['join', '--help'], ['claim', '--help']]) {
      const { code, out } = await run(argv);
      expect(code, argv.join(' ')).toBe(0);
      expect(out, argv.join(' ')).toContain('Usage: phm team');
    }
  });

  it('say --help does not post the flag as a message', async () => {
    const { code, out } = await run(['say', '--help', '--team', T]);
    expect(code).toBe(0);
    expect(out).toContain('Usage: phm team');
    expect(teamState(T).messages).toEqual([]);
  });

  it('join --help does not enroll the local human', async () => {
    const { code, out } = await run(['join', '--help', '--team', T]);
    expect(code).toBe(0);
    expect(out).toContain('Usage: phm team');
    expect(teamState(T).members).toEqual([]);
  });

  it('an unknown verb still refuses with usage and exit 2', async () => {
    const err: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { err.push(String(line)); });
    expect(await cmdTeam(['bogus', '--team', T])).toBe(2);
    expect(err.at(-1)).toContain('Usage: phm team');
  });
});
