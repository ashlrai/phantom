import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianContinue } from '../src/cli/fleet-guardian-continue.js';
import { writeGuardianDrainCheckpoint } from '../src/core/fleet/guardian-drain-checkpoint.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

const summary = { mode: 'apply', termination: 'drained', attempts: 1, verified: 1, refused: 0,
  attempted: [], planned: [], latestOutput: '/untrusted/state', session: '/private/session' };
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe('guardian-continue', () => {
  it('forwards options and status without enabling apply', async () => {
    const resume = vi.fn(async () => 5);
    const flags = ['--manifest', '/m', '--output-dir', '/o', '--max-retries', '2', '--timeout-ms', '10', '--stop-file', '/s', '--duration-ms', '5000', '--interval-ms', '1000', '--idle-backoff-max-ms', '2000', '--stream'];
    expect(await cmdFleetGuardianContinue(['--stdin', ...flags], { readInput: async () => JSON.stringify({ record: 'summary', ...summary }), resume })).toBe(5);
    expect(resume.mock.calls[0]![0]).toEqual(['--checkpoint-dir', summary.session, ...flags]);
  });

  it('accepts loop summaries and forwards explicit apply and json', async () => {
    const resume = vi.fn(async () => 0);
    const { attempted: _attempted, planned: _planned, ...rest } = summary;
    expect(await cmdFleetGuardianContinue(['--stdin', '--apply', '--json'], { readInput: async () => JSON.stringify({ ...rest, passes: 1 }), resume })).toBe(0);
    expect(resume.mock.calls[0]![0]).toEqual(['--checkpoint-dir', summary.session, '--apply', '--json']);
  });

  it('rejects invalid input without delegation and reports fixed errors', async () => {
    const resume = vi.fn(async () => 0);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const invalid = ['{', '{}', JSON.stringify({ session: '/private' }), JSON.stringify({ ...summary, mode: 'preview' }),
      JSON.stringify({ ...summary, session: null }), JSON.stringify({ ...summary, session: '/private/../x' }),
      JSON.stringify({ ...summary, truncated: true }), JSON.stringify({ ...summary, record: 'attempt' }),
      `${JSON.stringify(summary)}\n${JSON.stringify(summary)}`, 'x'.repeat(32769), new Uint8Array([255])];
    for (const input of invalid) expect(await cmdFleetGuardianContinue(['--stdin'], { readInput: async () => input, resume })).toBe(2);
    expect(await cmdFleetGuardianContinue(['--stdin'], { readInput: async () => { throw new Error('private'); }, resume })).toBe(2);
    expect(resume).not.toHaveBeenCalled();
    expect(err.mock.calls.every(([line]) => line === 'error: invalid guardian-continue summary\n')).toBe(true);
  });

  it('rejects forbidden, duplicate, unknown and incomplete options before reading', async () => {
    const readInput = vi.fn(async () => JSON.stringify(summary));
    const resume = vi.fn(async () => 0);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const args of [[], ['--stdin', '--stdin'], ['--stdin', '--apply', '--apply'], ['--stdin', '--manifest', '/a', '--manifest', '/b'],
      ['--stdin', '--source-state', '/x'], ['--stdin', '--checkpoint-dir', '/x'], ['--stdin', '--new-session'],
      ['--stdin', '--unknown'], ['--stdin', '--manifest'], ['--stdin', '--json', '--stream']]) {
      expect(await cmdFleetGuardianContinue(args, { readInput, resume })).toBe(2);
    }
    expect(readInput).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  });

  it('uses the private checkpoint state rather than the summary state', async () => {
    const session = await mkdtemp(join(tmpdir(), 'guardian-continue-src-')); dirs.push(session);
    const output = await mkdtemp(join(tmpdir(), 'guardian-continue-out-')); dirs.push(output);
    const latest = join(session, 'guardian-drain-attempt-1.json');
    await writeFile(latest, 'state', { mode: 0o600 });
    writeGuardianDrainCheckpoint(session, { version: 1, latestOutput: latest, repo: '/fake/repo', sha: 'a'.repeat(40), completedAt: '2026-11-01T23:31:00.000Z' });
    const select = vi.fn(async () => ({ repo: '/fake/repo', sha: 'b'.repeat(40) }));
    const prepare = vi.fn(async (o: { outputState: string }) => { await writeFile(o.outputState, 'state', { flag: 'wx' }); return { removed: 0, retained: 0, nextAction: 'synthetic' }; });
    const verify = vi.fn(async () => ({ state: 'ran', summary: { deadlineExceeded: false, cancelled: false } }) as unknown as GuardianVerifyExclusiveResult);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdFleetGuardianContinue(['--stdin', '--manifest', '/fake/manifest', '--output-dir', output, '--max-retries', '1', '--timeout-ms', '60000', '--apply', '--json'],
      { readInput: async () => JSON.stringify({ ...summary, session }), select, prepare, verify });
    expect(code).toBe(0); expect(select.mock.calls[0]![0].sourceState).toBe(latest); expect(verify).toHaveBeenCalledOnce();
  });
});
