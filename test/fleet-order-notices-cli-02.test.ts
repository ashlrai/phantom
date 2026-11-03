import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cmdFleetOrderNotices } from '../src/cli/fleet-order-notices.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'order-cli-'));
  dirs.push(root);
  for (const path of ['leader', 'queue/prompts', 'metrics']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'leader', 'MASON-INBOX.md'),
    '2026-11-01T04:08:00.000Z [src:desktop id:desk-fake01] Ship the plainly fake fix\n');
  writeFileSync(join(root, 'queue/prompts/RQ-PHX-FAKE1.md'), "Serve Mason's Nov 1 00:08 order");
  writeFileSync(join(root, 'metrics/jobs.jsonl'), JSON.stringify({ job: 'RQ-PHX-FAKE1', state: 'merged', url: 'https://github.com/example/fake/pull/1' }));
  return root;
}
it('dry-run prints the plan without writing the ledger', async () => {
  const root = fixture();
  const lines: string[] = [];
  expect(await cmdFleetOrderNotices(['--runs-dir', root, '--json'], { output: text => lines.push(text) })).toBe(0);
  expect(JSON.parse(lines[0]!).notices).toMatchObject([{ jobId: 'RQ-PHX-FAKE1', channel: 'desktop' }]);
  expect(lines[0]).toContain('https://github.com/example/fake/pull/1');
  expect(existsSync(join(root, 'queue/order-notices.jsonl'))).toBe(false);
});
it('--apply sends and writes a durable ledger, then plans nothing', async () => {
  const root = fixture();
  const lines: string[] = [];
  let calls = 0;
  const deps = { output: (text: string) => lines.push(text), senders: { desktop: async () => { calls++; } } };
  expect(await cmdFleetOrderNotices(['--runs-dir', root, '--apply', '--json'], deps)).toBe(0);
  expect(JSON.parse(lines[0]!)).toMatchObject({ sent: 1, skipped: 0, failed: 0 });
  expect(readFileSync(join(root, 'queue/order-notices.jsonl'), 'utf8')).toContain('"status":"sent"');
  await cmdFleetOrderNotices(['--runs-dir', root, '--json'], deps);
  expect(JSON.parse(lines[1]!).notices).toEqual([]);
  expect(calls).toBe(1);
});
it('returns 1 only for an unreadable trace and 2 for invalid arguments', async () => {
  const root = fixture();
  expect(await cmdFleetOrderNotices(['--runs-dir', join(root, 'missing')], { error: () => {} })).toBe(1);
  expect(await cmdFleetOrderNotices(['--bogus'], { error: () => {} })).toBe(2);
});
