/** `fleet main-health` joined with the stuck fix-PR ledger. Temp runs dir, injected ledger and clock. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetMainHealth } from '../src/cli/fleet-main-health.js';

const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime();
const PR = 'https://github.com/ashlrai/phantom/pull/9999';
const JOB = 'FIXUP-MAIN-phantom-abcdef1';
const stamp = '2026-11-04 11:58:00';
const STATUS = `# Main guardian status (${stamp} ET)

| repo | branch | last SHA checked | state | checked | failing check | open fix jobs | nightly CI red |
|---|---|---|---|---|---|---|---|
| phantom | master | 0860bdbb8c | red | 2026-11-04 11:55:00 | npm run typecheck | ${JOB} |  |
`;
const ledger = (...rows: object[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const published = { job: JOB, repo: 'phantom', url: PR, ts: new Date(NOW - 45 * 60_000).toISOString() };

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
function runsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'main-health-stuck-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'supervisor'));
  writeFileSync(join(dir, 'supervisor', 'status-main-guardian.md'), STATUS);
  return dir;
}
async function run(args: string[], readLedger: (p: string) => Promise<string>) {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); });
  const code = await cmdFleetMainHealth(args, { runsDir: runsDir(), now: () => NOW, readLedger });
  return { code, out };
}

describe('fleet main-health stuck fix PRs', () => {
  it('appends the stuck PR to the matching repo line and fails --strict', async () => {
    const { code, out } = await run(['--strict'], async () => ledger(published));
    expect(out[0]).toContain('phantom/master: red');
    expect(out[0]).toContain(`fix PR stuck 45 min ${PR}`);
    expect(out.join('\n')).not.toContain('ledger unread');
    expect(code).toBe(1);
  });

  it('lists a stuck row with no matching repo after the repo lines', async () => {
    const other = { job: 'FIXUP-MAIN-other-1234567', repo: 'ashlrai/other', url: 'https://github.com/ashlrai/other/pull/5', ts: published.ts };
    const { out } = await run([], async () => ledger(other));
    expect(out[0]).not.toContain('stuck');
    expect(out[1]).toBe('main-health: fix PR stuck 45 min https://github.com/ashlrai/other/pull/5 (FIXUP-MAIN-other-1234567)');
  });

  it('matches owner/name rows on the part after the last slash', async () => {
    const { out } = await run([], async () => ledger({ ...published, repo: 'ashlrai/phantom' }));
    expect(out[0]).toContain('fix PR stuck 45 min');
  });

  it('shows nothing once the PR is MERGED, and keeps the red-repo exit code', async () => {
    const merged = ledger(published, { job: JOB, state: 'MERGED', ts: new Date(NOW - 5 * 60_000).toISOString() });
    const plain = await run([], async () => merged);
    expect(plain.out.join('\n')).not.toContain('stuck');
    expect(plain.code).toBe(0);
    const strict = await run(['--strict'], async () => merged);
    expect(strict.code).toBe(1); // red repo, same as before this change
  });

  it('reports an unreadable ledger without failing', async () => {
    const reject = async (): Promise<string> => { throw new Error('EACCES'); };
    const text = await run([], reject);
    expect(text.out.at(-1)).toBe('main-health: fix PR ledger unread');
    expect(text.code).toBe(0);
    const json = await run(['--json'], reject);
    expect(JSON.parse(json.out[0]!).stuckFixes).toEqual({ known: false, thresholdMinutes: 20, stuck: [] });
  });

  it('keeps every FleetMainHealthV1 field in --json and adds stuckFixes', async () => {
    const { out } = await run(['--json'], async () => ledger(published));
    const parsed = JSON.parse(out[0]!);
    for (const key of ['v', 'generatedAt', 'source', 'statusAt', 'stale', 'guardianOff', 'red', 'repos']) expect(parsed).toHaveProperty(key);
    expect(parsed).toMatchObject({ v: 1, red: 1, source: 'ok' });
    expect(parsed.stuckFixes).toMatchObject({ known: true, thresholdMinutes: 20 });
    expect(parsed.stuckFixes.stuck).toEqual([expect.objectContaining({ job: JOB, prUrl: PR, ageMinutes: 45 })]);
  });
});
