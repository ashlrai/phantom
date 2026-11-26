import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdNode } from '../src/cli/node.js';
import { cmdNodeContributor, CONTRIBUTOR_USAGE } from '../src/cli/node-contributor.js';
import { contributorPlan, CONTRIBUTOR_SPEC } from '../src/core/drive/nodes/contributor.js';

// The plan is pure: no process, file, fetch or store access may happen.
vi.mock('node:child_process', () => ({
  exec: () => { throw new Error('No processes in the contributor plan'); },
  execFile: () => { throw new Error('No processes in the contributor plan'); },
  spawn: () => { throw new Error('No processes in the contributor plan'); },
}));
vi.mock('node:fs', () => ({
  readFileSync: () => { throw new Error('No host reads in the contributor plan'); },
  writeFileSync: () => { throw new Error('No writes in the contributor plan'); },
}));
vi.mock('node:fs/promises', () => ({
  readFile: () => { throw new Error('No host reads in the contributor plan'); },
  writeFile: () => { throw new Error('No writes in the contributor plan'); },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function capture() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.fn(() => { throw new Error('No network in the contributor plan'); });
  vi.stubGlobal('fetch', fetch);
  return { log, error, fetch };
}

describe('node contributor plan', () => {
  it('prints the enrollment contract as a non-executable plan without I/O', async () => {
    const { log, error, fetch } = capture();
    expect(await cmdNode(['contributor'])).toBe(0);
    const output = log.mock.calls.map(([line]) => line).join('\n');
    expect(output).toContain('no public broker is deployed');
    expect(output).toContain('revocable grant');
    expect(output).toContain('Public-only jobs');
    expect(output).toContain('verified-community');
    expect(output).toContain('docs/CONTRIBUTE-WITH-AN-AGENT.md');
    expect(error).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('emits one machine-readable plan that claims no readiness', async () => {
    const { log, fetch } = capture();
    expect(await cmdNode(['contributor', '--json'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const plan = JSON.parse(log.mock.calls[0]![0] as string);
    expect(plan).toMatchObject({
      schemaVersion: 1, command: 'contributor', dryRun: true, executable: false,
      broker: { status: 'not-deployed', spec: CONTRIBUTOR_SPEC },
    });
    expect(plan.tiers.map((t: { name: string }) => t.name)).toEqual(['guest', 'verified-community', 'enrolled-team']);
    expect(Object.keys(plan.verbs).sort()).toEqual(['join', 'leave', 'status']);
    expect(plan.today.length).toBeGreaterThanOrEqual(3);
    expect(plan).not.toHaveProperty('enrolled');
    expect(plan).not.toHaveProperty('ready');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('node contributor verbs while the broker is absent', () => {
  it('join refuses to enroll with a truthful unavailable error and today\'s paths', async () => {
    const { log, error, fetch } = capture();
    expect(await cmdNode(['contributor', 'join', '--json'])).toBe(1);
    const out = JSON.parse(log.mock.calls[0]![0] as string);
    expect(out).toMatchObject({
      schemaVersion: 1, command: 'contributor', verb: 'join', registered: false,
      broker: 'not-deployed',
      error: { code: 'unavailable' },
    });
    expect(out.error.fix).toContain('CONTRIBUTE-WITH-AN-AGENT.md');
    expect(error).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('join text mode names the same refusal on stderr', async () => {
    const { log, error } = capture();
    expect(await cmdNode(['contributor', 'join'])).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls.map(([line]) => line).join('\n')).toContain('not deployed');
  });

  it('status truthfully reports no enrollment', async () => {
    const { log } = capture();
    expect(await cmdNode(['contributor', 'status', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      schemaVersion: 1, command: 'contributor', verb: 'status', enrolled: false, broker: 'not-deployed',
    });
  });

  it('leave truthfully reports there is nothing to revoke', async () => {
    const { log } = capture();
    expect(await cmdNode(['contributor', 'leave', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      schemaVersion: 1, command: 'contributor', verb: 'leave', left: false,
      reason: 'no-contributor-session', broker: 'not-deployed',
    });
  });
});

describe('node contributor argument handling', () => {
  it.each([
    ['contributor', 'bogus'], ['contributor', 'join', 'status'], ['contributor', '--owner', 'ZZZVALUE'],
    ['contributor', 'join', '--json', '--json'], ['contributor', '--slots', 'ZZZNUM'],
    ['contributor', 'join', 'extra'],
  ])('refuses invalid invocation %j without echoing values (%#)', async (...args: string[]) => {
    const { log, error } = capture();
    expect(await cmdNode(args)).toBe(2);
    const out = [...log.mock.calls, ...error.mock.calls].flat().join(' ');
    expect(out).not.toContain('ZZZVALUE');
    expect(out).not.toContain('ZZZNUM');
  });

  it('returns a structured usage error under --json', async () => {
    const { log, error } = capture();
    expect(await cmdNode(['contributor', 'bogus', '--json'])).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      schemaVersion: 1, command: 'contributor', error: { code: 'usage' },
    });
    expect(error).not.toHaveBeenCalled();
  });

  it.each([['contributor', '--help'], ['contributor', 'join', '-h'], ['contributor', '--help', '--json']])(
    'help never acts: %j (%#)', async (...args: string[]) => {
      const { log, error, fetch } = capture();
      expect(await cmdNode(args)).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('Usage: phm node contributor');
      expect(error).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('the plan module itself stays pure and total', () => {
    capture();
    const plan = contributorPlan();
    expect(plan.dryRun).toBe(true);
    expect(plan.executable).toBe(false);
    expect(plan.broker.status).toBe('not-deployed');
    for (const v of ['join', 'status', 'leave'] as const) {
      expect(() => cmdNodeContributor([v, '--json'])).not.toThrow();
    }
    expect(CONTRIBUTOR_USAGE).toContain('not deployed');
  });
});
