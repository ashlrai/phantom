import { Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { cmdFleetCiReceiptAwaitBatch } from '../src/cli/fleet-ci-receipt-await-batch.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

it('streams later entries after a local timeout using the real batch and receipt wait', async () => {
  let time = 0;
  const calls: string[] = [];
  const gh: GitRunner = async (_bin, args) => {
    const url = args.at(-1)!; calls.push(url);
    const run = url.includes('/runs/1/') ? 1 : 2;
    const value = url.includes('/attempts/')
      ? { id: run, run_attempt: 1, head_sha: 'a'.repeat(40), status: run === 1 ? 'in_progress' : 'completed', repository: { full_name: 'example/repo' } }
      : [{ total_count: 0, artifacts: [] }];
    return { code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false, missing: false };
  };
  const targets = [1, 2].map((run) => ({ repo: 'example/repo', run, attempt: 1, artifactName: 'receipts' }));
  const input = (async function* () { yield JSON.stringify({ version: 1, targets }); })();
  const lines: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { lines.push(String(chunk)); callback(); } });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await cmdFleetCiReceiptAwaitBatch(
      ['--stdin', '--timeout-ms', '1000', '--poll-ms', '250', '--target-timeout-ms', '500', '--ndjson'],
      { input, output, gh, now: () => time, sleep: async (ms) => { time += ms; } });
    const events = lines.map((line) => JSON.parse(line));
    expect(code).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['entry', 'entry', 'summary']);
    expect(events.slice(0, 2).map((event) => [event.entry.run, event.entry.outcome, event.entry.prior]))
      .toEqual([[1, 'failed', null], [2, 'failed', null]]);
    expect(events[0].entry.reason).toContain('timed out');
    expect(events[1].entry.reason).toContain('completed');
    expect(events[2]).toMatchObject({ failed: 2, notStarted: 0, timedOut: false });
    expect(calls.some((url) => url.includes('/runs/2/'))).toBe(true);
    expect(time).toBe(500);
  } finally { stderr.mockRestore(); }
});
