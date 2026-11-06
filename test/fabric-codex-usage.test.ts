import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { parseCodexUsage, readCodexUsage } from '../src/core/fabric/readers/codex-usage.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const RESET = NOW / 1000 + 3_600;
function window(pct = 25, reset = RESET) { return { usedPercent: pct, resetsAt: reset, windowDurationMins: 300 }; }
function payload(primary: unknown = window(), secondary: unknown = null) {
  return { rateLimits: { limitId: 'codex', primary, secondary } };
}

describe('CMP native quota parsing', () => {
  it('records measured usage and the shared Terra account reset', () => {
    expect(parseCodexUsage(payload(), NOW)).toEqual({ pctUsed: 25,
      resetAt: '2030-01-01T01:00:00.000Z', terraResetAt: '2030-01-01T01:00:00.000Z' });
  });

  it('selects the fullest window with its own reset, then the later reset on ties', () => {
    expect(parseCodexUsage(payload(window(10), window(80, RESET + 86400)), NOW))
      .toMatchObject({ pctUsed: 80, resetAt: new Date((RESET + 86400) * 1000).toISOString() });
    expect(parseCodexUsage(payload(window(80), window(80, RESET + 86400)), NOW))
      .toMatchObject({ pctUsed: 80, resetAt: new Date((RESET + 86400) * 1000).toISOString() });
  });

  it('uses the exact codex bucket in multi-bucket results', () => {
    expect(parseCodexUsage({ ...payload(), rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: window(42) },
      codex_other: { limitId: 'codex_other', primary: window(100) },
    } }, NOW)).toMatchObject({ pctUsed: 42 });
    expect(parseCodexUsage({ rateLimitsByLimitId: { codex: { primary: window(35) } } }, NOW).pctUsed).toBe(35);
    expect(parseCodexUsage({ rateLimitsByLimitId: Object.create({ codex: { primary: window() } }) }, NOW).pctUsed).toBeNull();
  });

  it.each([{}, null, { other: { primary: window() } }, { codex: { limitId: 'other', primary: window() } }])(
    'does not fall back when the authoritative map is absent or invalid: %j', map => {
      expect(parseCodexUsage({ ...payload(), rateLimitsByLimitId: map }, NOW).pctUsed).toBeNull();
    });

  it.each([null, {}, [], 'status unavailable', { rateLimits: { limitId: 'other', primary: window() } },
    payload(null), payload({ resetsAt: RESET }), payload({ usedPercent: 25 }),
    payload(window(-1)), payload(window(101)), payload(window(NaN)), payload(window(Infinity)),
    payload(window(25, RESET * 1000)), payload(window(25, NOW / 1000)),
    payload(window(25, RESET + 0.5)), payload(window(25, Infinity)), payload(window(), window(50, 0)),
  ])('returns unknown for unusable evidence: %j', input => {
    expect(parseCodexUsage(input, NOW)).toEqual({ pctUsed: null, resetAt: null, terraResetAt: null });
  });

  it('preserves observed zero and full usage without inventing denial percentages', () => {
    expect(parseCodexUsage(payload(window(0)), NOW).pctUsed).toBe(0);
    expect(parseCodexUsage(payload(window(100)), NOW).pctUsed).toBe(100);
    expect(parseCodexUsage({ rateLimits: { ...payload().rateLimits, rateLimitReachedType: 'weekly' } }, NOW).pctUsed).toBeNull();
  });

  it('contains unexpected parser exceptions', () => {
    const input = Object.defineProperty({}, 'rateLimits', { get() { throw new Error('TEST unreadable'); } });
    expect(parseCodexUsage(input, NOW).pctUsed).toBeNull();
  });
});

describe('CMP isolated status and log pipeline', () => {
  let root: string;
  let home: string;
  let sent: Record<string, unknown>[];
  let child: EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  let nativePayload: unknown;
  let mode: string;
  let privateDiagnostic: string;

  beforeEach(async () => {
    vi.mocked(spawn).mockReset();
    root = await mkdtemp(join(await realpath(tmpdir()), 'phantom-cmp-usage-test-'));
    home = join(root, 'cmp');
    await mkdir(join(home, '.codex'), { recursive: true });
    sent = []; mode = 'ok'; nativePayload = payload();
    // Secret-shaped fixtures are constructed at runtime and never printed.
    privateDiagnostic = ['sk', 'TEST', 'x'.repeat(48)].join('-');
    vi.mocked(spawn).mockImplementation((_command, _args, options) => {
      child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; }),
        stdin: new Writable({
          write(chunk, _encoding, callback) {
            const request = JSON.parse(chunk.toString()); sent.push(request);
            queueMicrotask(() => {
              if (mode === 'hang') return;
              if (mode === 'spawn-error') { child.emit('error', new Error(privateDiagnostic)); return; }
              if (mode === 'malformed') { child.stdout.write('invalid json\n'); return; }
              if (mode === 'overflow') { child.stderr.write('x'.repeat(256 * 1024 + 1)); return; }
              if (mode === 'partial') { child.stdout.write('{'); child.emit('close', 0, null); return; }
              if (request.method === 'initialize') {
                const env = options!.env!;
                const codexHome = mode === 'wrong-home' ? join(root, 'other') : env.CODEX_HOME;
                child.stdout.write(JSON.stringify({ id: 1, result: { codexHome } }) + '\n');
              } else if (request.method === 'account/rateLimits/read') {
                child.stderr.write(privateDiagnostic);
                if (mode === 'account-change') {
                  child.stdout.write(JSON.stringify({ method: 'account/updated', params: { privateDiagnostic } }) + '\n');
                } else if (mode === 'refresh-request') {
                  child.stdout.write(JSON.stringify({ id: 10, method: 'account/chatgptAuthTokens/refresh' }) + '\n');
                } else if (mode === 'provider-error') {
                  child.stdout.write(JSON.stringify({ id: 2, error: { message: privateDiagnostic } }) + '\n');
                } else child.stdout.write(JSON.stringify({ id: 2, result: nativePayload }) + '\n');
              }
            });
            callback();
          },
          final(callback) {
            if (mode !== 'exit-hang') queueMicrotask(() => child.emit('close', mode === 'exit-failed' ? 1 : 0, null));
            callback();
          },
        }),
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
  });

  afterEach(async () => {
    vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('runs only metadata calls in the explicit CMP HOME and logs both aliases with resets', async () => {
    vi.stubEnv('CODEX_HOME', join(root, 'wrong-account'));
    vi.stubEnv('OPENAI_API_KEY', privateDiagnostic);
    nativePayload = { ...payload(), privateDiagnostic };
    const stdout = vi.spyOn(console, 'log'); const stderr = vi.spyOn(console, 'error');
    const logPath = join(root, 'usage-readings.log');
    const reading = await readCodexUsage({ home, logPath });
    expect(reading).toMatchObject({ pool: 'codex-cmp', pctUsed: 25, source: 'codex-reader' });
    const args = vi.mocked(spawn).mock.calls[0]!;
    expect(args[0]).toBe('codex');
    expect(args[1]).toEqual(['app-server', '--stdio', '-c', 'analytics.enabled=false',
      '-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"']);
    expect(args[2]).toMatchObject({ cwd: home, shell: false,
      env: { HOME: home, CODEX_HOME: join(home, '.codex') } });
    expect(Object.keys(args[2]!.env!).sort()).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'PATH']);
    expect(sent.map(r => r.method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
    const log = await readFile(logPath, 'utf8');
    const rows = log.trim().split('\n').map(row => JSON.parse(row));
    expect(rows).toEqual([ { ...reading, used: 25 }, { ...reading, pool: 'terra@cmp', used: 25 } ]);
    expect(rows.every(row => row.resetAt === reading.terraResetAt && Number.isFinite(Date.parse(row.resetAt)))).toBe(true);
    expect(log.includes(privateDiagnostic)).toBe(false);
    expect(log.includes(home)).toBe(false);
    if (process.platform !== 'win32') expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
  });

  it.each(['missing', 'relative', 'operator', 'auth-dir', 'secondary-auth-dir', 'symlink-home', 'symlink-profile', 'missing-profile', 'file-profile'])(
    'refuses unsafe or unbound HOME without spawning: %s', async kind => {
      let candidate: string | undefined;
      if (kind === 'relative') candidate = 'cmp';
      if (kind === 'operator') candidate = userInfo().homedir;
      if (kind === 'auth-dir') candidate = join(userInfo().homedir, '.codex');
      if (kind === 'secondary-auth-dir') candidate = join(userInfo().homedir, '.codex-2');
      if (kind === 'symlink-home') { candidate = join(root, 'alias'); await symlink(home, candidate); }
      if (kind === 'symlink-profile') {
        await rm(join(home, '.codex'), { recursive: true });
        await mkdir(join(root, 'other-profile'));
        await symlink(join(root, 'other-profile'), join(home, '.codex')); candidate = home;
      }
      if (kind === 'missing-profile' || kind === 'file-profile') {
        await rm(join(home, '.codex'), { recursive: true }); candidate = home;
        if (kind === 'file-profile') await writeFile(join(home, '.codex'), 'TEST profile placeholder');
      }
      vi.mocked(spawn).mockClear();
      expect((await readCodexUsage({ home: candidate })).pctUsed).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
    });

  it.each(['spawn-error', 'malformed', 'overflow', 'partial', 'wrong-home', 'account-change', 'refresh-request', 'provider-error', 'exit-failed'])(
    'logs unknown and discards diagnostics on %s', async failure => {
      mode = failure;
      const logPath = join(root, 'usage-readings.log');
      const reading = await readCodexUsage({ home, logPath });
      expect(reading).toMatchObject({ pctUsed: null, resetAt: null, terraResetAt: null });
      const log = await readFile(logPath, 'utf8');
      expect(log.includes(privateDiagnostic)).toBe(false);
      expect(log.trim().split('\n').map(row => JSON.parse(row).used)).toEqual(['unknown', 'unknown']);
    });

  it.each(['hang', 'exit-hang'])('bounds the complete native exchange, including %s', async failure => {
    mode = failure;
    vi.useFakeTimers();
    const pending = readCodexUsage({ home });
    // Home validation uses real filesystem promises before the timer starts.
    await vi.waitFor(() => expect(vi.mocked(spawn).mock.calls.length).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(8_000);
    expect((await pending).pctUsed).toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('propagates log failures so callers cannot claim a persisted reading', async () => {
    await expect(readCodexUsage({ logPath: join(root, 'missing', 'usage-readings.log') })).rejects.toThrow();
  });
});
