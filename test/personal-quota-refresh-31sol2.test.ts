import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdResources } from '../src/cli/resources.js';

let root: string, home: string, bin: string;
let output: ReturnType<typeof vi.spyOn>;
const bucket = (usedPercent = 0) => ({ limitId: 'codex', primary: {
  usedPercent, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600,
}, secondary: { usedPercent, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 } });
function native(payload: unknown, mode = ''): void {
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync('pid', String(process.pid));
fs.writeFileSync(${JSON.stringify(join(root, 'spawned'))}, 'fake');
if (process.env.CODEX_HOME !== process.cwd()) process.exit(5);
const rl = require('node:readline').createInterface({input:process.stdin});
const send = v => console.log(JSON.stringify(v));
rl.on('line', line => {
 const v = JSON.parse(line);
 if (v.method === 'initialize') send({id:1,result:{codexHome:process.env.CODEX_HOME}});
 else if (v.method === 'account/rateLimits/read') {
   console.error('FAKE_SECRET_RAW_DIAGNOSTIC');
   ${mode === 'timeout' ? 'setInterval(() => {}, 1000); return;' : ''}
   ${mode === 'truncated' ? "process.stdout.write('{\\\"id\\\":'); rl.close(); process.exit(0);" : ''}
   ${mode === 'account' ? "send({method:'account/updated',params:{secret:'FAKE_SECRET'}});" : ''}
   ${mode === 'overflow' ? "console.log('x'.repeat(300000));" : ''}
   send({id:${mode === 'wrong' ? 99 : 2}, ${mode === 'error' ? "error:{message:'FAKE_SECRET'}" : `result:${JSON.stringify(payload)}`}});
 }
});
`);
  chmodSync(join(bin, 'codex'), 0o755);
}
async function run(refresh = true, selected = home) {
  const code = await cmdResources(['personal', '--json', '--home', selected, ...(refresh ? ['--refresh'] : [])]);
  const text = output.mock.calls.map(c => c.join(' ')).join('\n');
  expect(text).not.toContain('FAKE_SECRET');
  return { code, report: text ? JSON.parse(text) : null };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'personal-probe-')); home = join(root, 'personal'); bin = join(root, 'bin');
  mkdirSync(home); mkdirSync(bin); vi.stubEnv('PATH', bin); vi.stubEnv('CODEX_HOME', '/fake/ambient');
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe('personal refresh through cmdResources', { timeout: 12000 }, () => {
  it('replaces cached 100 used with a live zero used reset', async () => {
    const sessions = join(home, 'sessions', '2026', '10', '31'); mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'rollout-fake.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(),
      type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 } } } }) + '\n');
    const cached = await run(false); expect(cached.report.resources[0].session.usedPct).toBe(100);
    output.mockClear();
    native({ rateLimitsByLimitId: { codex: bucket() } });
    const { code, report } = await run(); expect(code).toBe(0);
    expect(report.resources[0].session).toMatchObject({ usedPct: 0, leftPct: 100 });
    expect(report.resources[0].weekly.usedPct).toBe(0);
  });
  it('retains exhausted usage, denial and remaining spend-control semantics', async () => {
    native({ ordinaryUsageAllowed: false, rateLimits: { ...bucket(100), spendControlReached: true,
      individualLimit: { remainingPercent: 17 } } });
    const { report, code } = await run(); expect(code).toBe(0);
    expect(report.resources[0]).toMatchObject({ limitReached: true, spendControlReached: true, individualLimitPercent: 17 });
    expect(report.resources[0].weekly).toMatchObject({ usedPct: 100, leftPct: 0 });
  });
  it.each(['missing', 'truncated', 'wrong', 'account', 'error', 'overflow', 'malformed', 'absent'])(
    'fails closed for %s without diagnostics', async mode => {
      native(mode === 'missing' ? { rateLimitsByLimitId: {}, rateLimits: bucket() } :
        { rateLimits: mode === 'absent' ? { limitId: 'codex' } : mode === 'malformed' ? bucket(-1) : bucket() }, mode);
      const { code, report } = await run(); expect(code).toBe(1);
      expect(report.refresh.status).toBe('failed'); expect(report.resources[0].state).toBe('unavailable');
    });
  it('kills a hung child at the elapsed deadline', async () => {
    native({}, 'timeout'); const { code } = await run(); expect(code).toBe(1);
    const pid = Number(readFileSync(join(home, 'pid'), 'utf8'));
    // Allow the OS to deliver the already-sent SIGKILL and reap the child.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 11000);
  it('rejects forbidden paths and symlink aliases before spawn', async () => {
    native({ rateLimits: bucket() });
    const forbidden = join(root, '.codex'); const alias = join(root, 'alias');
    mkdirSync(forbidden); symlinkSync(forbidden, alias);
    for (const path of [forbidden, alias, join(root, '..', '.codex')]) {
      output.mockClear(); expect((await run(true, path)).code).not.toBe(0);
    }
    expect(() => readFileSync(join(root, 'spawned'))).toThrow();
  });
  it('default mode never spawns', async () => {
    native({ rateLimits: bucket() }); await run(false);
    expect(() => readFileSync(join(root, 'spawned'))).toThrow();
  });
});
