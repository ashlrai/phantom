import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetEmailOutboxAwait } from '../src/cli/fleet-email-outbox-await.js';

const name = 'artifact.reply.eml';
const bytes = 'To: fake@example.test\nSubject: private-subject\n\nprivate-body';
const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-await-'));
  dirs.push(dir);
  return dir;
}
function args(dir: string): string[] { return ['--name', name, '--timeout-ms', '300', '--poll-ms', '100', '--dir', dir, '--json']; }
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('email outbox await', () => {
  for (const state of ['drafted', 'sent'] as const) {
    it(`waits for ${state} without changing the artifact or leaking content`, async () => {
      const dir = fixture();
      mkdirSync(join(dir, state));
      writeFileSync(join(dir, name), bytes);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      let now = 0;
      const code = await cmdFleetEmailOutboxAwait(args(dir), { now: () => now, sleep: async () => {
        now += 100;
        renameSync(join(dir, name), join(dir, state, name));
      } });
      expect(code).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ name, state, timedOut: false, cancelled: false });
      expect(String(log.mock.calls[0]![0])).not.toMatch(/fake@|private-/);
      expect(readFileSync(join(dir, state, name), 'utf8')).toBe(bytes);
    });
  }
  it('reports an interrupted claim as stuck', async () => {
    const dir = fixture(); mkdirSync(join(dir, 'sending')); writeFileSync(join(dir, 'sending', name), bytes);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetEmailOutboxAwait(args(dir))).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ state: 'stuck', reason: 'interrupted-send' });
    expect(readFileSync(join(dir, 'sending', name), 'utf8')).toBe(bytes);
  });
  it('times out for a missing artifact and distinguishes a missing source', async () => {
    const dir = fixture(); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let now = 0;
    expect(await cmdFleetEmailOutboxAwait(args(dir), { now: () => now, sleep: async (ms) => { now += ms; } })).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]![0])).timedOut).toBe(true);
    expect(await cmdFleetEmailOutboxAwait(args(join(dir, 'missing')))).toBe(1);
    expect(JSON.parse(String(log.mock.calls[1]![0]))).toMatchObject({ reason: 'source-failure', timedOut: false });
    const file = join(dir, 'not-directory'); writeFileSync(file, 'x');
    expect(await cmdFleetEmailOutboxAwait(args(file))).toBe(1);
    expect(JSON.parse(String(log.mock.calls[2]![0])).reason).toBe('source-failure');
  });
  it('cancels without subsequent reads', async () => {
    const dir = fixture(); const controller = new AbortController();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn(() => ({ dir, counts: { queued: 0, drafted: 0, sent: 0, stuck: 0 }, entries: [] }));
    expect(await cmdFleetEmailOutboxAwait(args(dir), { read, signal: controller.signal, sleep: async () => { controller.abort(); } })).toBe(130);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid arguments before reading', async () => {
    const dir = fixture(); const read = vi.fn(); vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const input of [args(dir).concat('--json'), args(dir).concat('--bad'), args(dir).map((x) => x === name ? '../x.reply.eml' : x), args(dir).map((x) => x === '300' ? 'Infinity' : x), args(dir).map((x) => x === '100' ? '99' : x), args('relative')]) {
      expect(await cmdFleetEmailOutboxAwait(input, { read })).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
  });
});
