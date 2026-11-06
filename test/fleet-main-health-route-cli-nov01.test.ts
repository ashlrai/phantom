/**
 * Main-guardian status on the wire: the pure parser, `readFleetMainHealth`,
 * `ashlr fleet main-health` and `GET /api/verse/runs-history/main-health`.
 * Temp runs dirs and fixture repo names only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetMainHealth } from '../src/cli/fleet-main-health.js';
import { MAIN_HEALTH_STALE_MS, parseMainGuardianStatus, readFleetMainHealth } from '../src/core/fleet/main-health.js';
import { createRunsHistoryApi, VERSE_RUNS_HISTORY_MAIN_HEALTH_PATH as PATH } from '../src/core/verse/runs-history-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;
const NOW = new Date(2026, 10, 1, 23, 50, 0).getTime();
const SAMPLE = `# Main guardian status (2026-11-01 23:47:15 ET)

| repo | branch | last SHA checked | state | checked | failing check | open fix jobs | nightly CI red |
|---|---|---|---|---|---|---|---|
| phantom | master | 0860bdbb8c | red | 2026-11-01 23:40:12 | npm run typecheck | FIXUP-MAIN-phantom-a1f206c |  |
| ashlr-md | main | 6e97fd8537 | green | 2026-11-01 23:42:07 |  |  |  |

Kill switch: touch ~/.ashlr-runs/queue/MAIN_GUARDIAN_OFF. Log: ...
`;
const header = (stamp: string) => `# Main guardian status (${stamp} ET)\n\n| repo | branch |\n|---|---|\n`;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
function runsDir(status?: string, off = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'main-health-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'supervisor'));
  mkdirSync(join(dir, 'queue'));
  if (status !== undefined) writeFileSync(join(dir, 'supervisor', 'status-main-guardian.md'), status);
  if (off) writeFileSync(join(dir, 'queue', 'MAIN_GUARDIAN_OFF'), '');
  return dir;
}

describe('parseMainGuardianStatus', () => {
  it('parses red and green rows with blank cells', () => {
    const report = parseMainGuardianStatus(SAMPLE, NOW);
    expect(report).toMatchObject({ v: 1, stale: false, red: 1 });
    expect(report.statusAt).toMatch(/^2026-11-01T23:47:15/);
    expect(report.repos).toEqual([
      expect.objectContaining({ repo: 'phantom', branch: 'master', sha: '0860bdbb8c', state: 'red', failingCheck: 'npm run typecheck', fixJobs: ['FIXUP-MAIN-phantom-a1f206c'], nightlyRed: null }),
      expect.objectContaining({ repo: 'ashlr-md', branch: 'main', state: 'green', failingCheck: null, fixJobs: [], nightlyRed: null }),
    ]);
    expect(report.repos[0]!.checkedAt).toMatch(/^2026-11-01T23:40:12/);
  });

  it('splits several fix jobs on commas and spaces', () => {
    const text = `${header('2026-11-01 23:47:15')}| r | main | abcdef1 | red | x | lint | FIXUP-A, FIXUP-B FIXUP-C | nightly |\n`;
    expect(parseMainGuardianStatus(text, NOW).repos[0]).toMatchObject({ fixJobs: ['FIXUP-A', 'FIXUP-B', 'FIXUP-C'], nightlyRed: 'nightly', checkedAt: null });
  });

  it('drops malformed rows, bad shas and control characters without throwing', () => {
    const text = `${header('2026-11-01 23:47:15')}| only | three | cells |\n|  |  | abc | red |\n| ok | main | not-a-sha | green | | bad\x07check |\nplain text\n`;
    const report = parseMainGuardianStatus(text, NOW);
    expect(report.repos).toEqual([expect.objectContaining({ repo: 'ok', sha: null, failingCheck: 'badcheck' })]);
    expect(() => parseMainGuardianStatus('\0|||\n| a', NOW)).not.toThrow();
  });

  it('bounds rows at 64 and cells at 200 characters', () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| r${i} | main | | green | | ${'x'.repeat(300)} | | |`).join('\n');
    const report = parseMainGuardianStatus(`${header('2026-11-01 23:47:15')}${rows}\n`, NOW);
    expect(report.repos).toHaveLength(64);
    expect(report.repos[0]!.failingCheck).toHaveLength(200);
  });

  it('maps any other state word to unknown', () => {
    const text = `${header('2026-11-01 23:47:15')}| r | main | | pending | | | | |\n`;
    expect(parseMainGuardianStatus(text, NOW)).toMatchObject({ red: 0, repos: [{ state: 'unknown' }] });
  });

  it('is stale past 30 minutes, fresh before, and stale without a heading', () => {
    const at = (minutesAgo: number) => {
      const d = new Date(NOW - minutesAgo * 60_000);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    expect(MAIN_HEALTH_STALE_MS).toBe(30 * 60_000);
    expect(parseMainGuardianStatus(header(at(31)), NOW).stale).toBe(true);
    expect(parseMainGuardianStatus(header(at(29)), NOW).stale).toBe(false);
    expect(parseMainGuardianStatus('| r | main | | green |\n', NOW)).toMatchObject({ stale: true, statusAt: null });
  });
});

describe('readFleetMainHealth', () => {
  it('reads the status file and the kill switch', async () => {
    const report = await readFleetMainHealth({ runsDir: runsDir(SAMPLE, true), now: () => NOW });
    expect(report).toMatchObject({ source: 'ok', guardianOff: true, red: 1 });
    expect((await readFleetMainHealth({ runsDir: runsDir(SAMPLE), now: () => NOW })).guardianOff).toBe(false);
  });

  it('answers unavailable and stale when the file is missing', async () => {
    expect(await readFleetMainHealth({ runsDir: runsDir(), now: () => NOW })).toMatchObject({
      v: 1, source: 'unavailable', stale: true, statusAt: null, red: 0, repos: [],
    });
  });
});

describe('ashlr fleet main-health', () => {
  const run = async (args: string[], dir: string) => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await cmdFleetMainHealth(args, { runsDir: dir, now: () => NOW });
    return { code, lines };
  };

  it('prints red rows first with the failing check and fix jobs, exit 0', async () => {
    const green = '| ashlr-md | main | 6e97fd8537 | green | 2026-11-01 23:42:07 |  |  |  |';
    const red = '| phantom | master | 0860bdbb8c | red | 2026-11-01 23:40:12 | npm run typecheck | FIXUP-A FIXUP-B |  |';
    const { code, lines } = await run([], runsDir(`${header('2026-11-01 23:47:15')}${green}\n${red}\n`));
    expect(code).toBe(0);
    expect(lines).toEqual(['phantom/master: red (npm run typecheck), fix FIXUP-A FIXUP-B', 'ashlr-md/main: green']);
  });

  it('--json returns phantom with state and fix job', async () => {
    const { code, lines } = await run(['--json'], runsDir(SAMPLE));
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!).repos[0]).toMatchObject({ repo: 'phantom', state: 'red', fixJobs: ['FIXUP-MAIN-phantom-a1f206c'] });
  });

  it('--strict exits 1 on red, stale or unavailable and 0 when green and fresh', async () => {
    expect((await run(['--strict'], runsDir(SAMPLE))).code).toBe(1);
    expect((await run(['--strict'], runsDir())).code).toBe(1);
    const stale = '# Main guardian status (2026-11-01 20:00:00 ET)\n\n| repo | branch | sha | state |\n|---|---|---|---|\n| r | main | | green |\n';
    expect((await run(['--strict'], runsDir(stale))).code).toBe(1);
    const fresh = '# Main guardian status (2026-11-01 23:47:15 ET)\n\n| r | main | | green |\n';
    expect((await run(['--strict'], runsDir(fresh))).code).toBe(0);
  });

  it('names stale, unavailable and off lines in text output', async () => {
    const { lines } = await run([], runsDir(undefined, true));
    expect(lines).toEqual(['main-health: guardian status unavailable', expect.stringContaining('OFF')]);
  });

  it('exits 2 on an unknown flag and 0 on --help', async () => {
    expect((await run(['--bogus'], runsDir(SAMPLE))).code).toBe(2);
    expect((await run(['--help'], runsDir(SAMPLE))).code).toBe(0);
  });
});

describe('GET /api/verse/runs-history/main-health', () => {
  async function call(method: string, dir: string, url = PATH) {
    const req = new PassThrough() as IncomingMessage & PassThrough;
    Object.assign(req, { method, url, headers: {} });
    req.end();
    let status = 0;
    let payload = '';
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(chunk?: string) { payload = chunk ?? ''; return this; },
    } as unknown as ServerResponse;
    const handled = await createRunsHistoryApi({ runsDir: dir })(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
    return { handled, status, json: payload ? (JSON.parse(payload) as Record<string, unknown>) : null };
  }

  it('serves the pinned shape from a temp runs dir', async () => {
    const result = await call('GET', runsDir(SAMPLE, true));
    expect(result).toMatchObject({ handled: true, status: 200, json: { v: 1, source: 'ok', guardianOff: true, red: 1 } });
    expect((result.json!.repos as unknown[])).toHaveLength(2);
  });

  it('answers 200 unavailable for a missing file, 405 for other methods, 400 for query keys', async () => {
    expect((await call('GET', runsDir())).json).toMatchObject({ source: 'unavailable', repos: [] });
    expect((await call('POST', runsDir(SAMPLE))).status).toBe(405);
    expect((await call('GET', runsDir(SAMPLE), `${PATH}?x=1`)).status).toBe(400);
  });
});
