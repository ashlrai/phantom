import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  USAGE_ACTIVE_INTERVAL_MS, isCi, isInternal, maybeSendUsagePing, planUsagePing, telemetryDisabledByEnv,
} from '../src/core/metrics/usage-ping.js';

let dir: string;
let stateFile: string;
let sent: unknown[];
const fakeFetch = (async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)));
  return new Response('{}', { status: 202 });
}) as unknown as typeof fetch;
const quiet = { isTTY: false, write: () => true };
const base = (env: NodeJS.ProcessEnv = {}, now = new Date('2026-11-24T07:00:00Z')) =>
  ({ env, now: () => now, fetch: fakeFetch, stateFile, stderr: quiet, platform: 'darwin', arch: 'arm64' });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'usage-ping-')); stateFile = join(dir, 'usage-telemetry.json'); sent = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('usage ping', () => {
  it('sends one install ping with only the allowlisted fields', async () => {
    const p = await maybeSendUsagePing('phantom', '3.30.72', base());
    expect(p?.event).toBe('install');
    expect(Object.keys(sent[0] as object).sort()).toEqual(['arch', 'env', 'event', 'install_id', 'internal', 'os', 'schema', 'tool', 'version']);
    expect((sent[0] as { install_id: string }).install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((sent[0] as { env: string }).env).toBe('dev');
  });

  it('sends nothing again within a week, then one active ping', async () => {
    const t0 = new Date('2026-11-24T07:00:00Z');
    await maybeSendUsagePing('phantom', '1.0.0', base({}, t0));
    expect(await maybeSendUsagePing('phantom', '1.0.0', base({}, new Date(t0.getTime() + 2 * 3600_000)))).toBeNull();
    const later = await maybeSendUsagePing('phantom', '1.0.0', base({}, new Date(t0.getTime() + USAGE_ACTIVE_INTERVAL_MS)));
    expect(later?.event).toBe('active');
    expect(sent).toHaveLength(2);
    expect((sent[0] as { install_id: string }).install_id).toBe((sent[1] as { install_id: string }).install_id);
  });

  it.each([
    [{ ASHLR_TELEMETRY: '0' }], [{ ASHLR_TELEMETRY: 'off' }], [{ DO_NOT_TRACK: '1' }], [{ VITEST: 'true' }],
  ])('honors opt-out %o', async (env) => {
    expect(telemetryDisabledByEnv(env)).toBe(true);
    expect(await maybeSendUsagePing('phantom', '1.0.0', base(env))).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('honors "disabled": true in the state file', async () => {
    writeFileSync(stateFile, JSON.stringify({ disabled: true }));
    expect(await maybeSendUsagePing('phantom', '1.0.0', base())).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('tags CI and internal fleet machines', async () => {
    expect(isCi({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCi({ CI: 'false' })).toBe(false);
    expect(isInternal({ ASHLR_INTERNAL: '1' }, {})).toBe(true);
    expect(isInternal({ GITHUB_REPOSITORY_OWNER: 'ashlrai' }, {})).toBe(true);
    expect(isInternal({}, { internal: true })).toBe(true);
    expect(isInternal({}, {})).toBe(false);
    const p = await maybeSendUsagePing('phantom', '1.0.0', base({ CI: 'true', ASHLR_INTERNAL: '1' }));
    expect(p).toMatchObject({ env: 'ci', internal: true });
  });

  it('never sends when state cannot be persisted', async () => {
    const p = await maybeSendUsagePing('phantom', '1.0.0', { ...base(), stateFile: join(dir, 'missing', '\0bad') });
    expect(p).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('prints the first-run notice once on a TTY', async () => {
    const lines: string[] = [];
    const tty = { isTTY: true, write: (s: string) => lines.push(s) };
    await maybeSendUsagePing('phantom', '1.0.0', { ...base(), stderr: tty });
    await maybeSendUsagePing('phantom', '1.0.0', { ...base({}, new Date('2026-12-30T00:00:00Z')), stderr: tty });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ASHLR_TELEMETRY=0');
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).noticeShownAt).toBeTruthy();
  });

  it('plans install, then active weekly', () => {
    const now = new Date('2026-11-24T00:00:00Z');
    expect(planUsagePing({}, now)).toBe('install');
    expect(planUsagePing({ installSentAt: now.toISOString() }, now)).toBeNull();
    expect(planUsagePing({ installSentAt: '2026-11-01T00:00:00Z' }, now)).toBe('active');
  });

  it('never rejects when the network fails, and retries at most hourly', async () => {
    const boom = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const t0 = new Date('2026-11-24T07:00:00Z');
    await expect(maybeSendUsagePing('phantom', '1.0.0', { ...base({}, t0), fetch: boom })).resolves.toBeNull();
    expect(await maybeSendUsagePing('phantom', '1.0.0', base({}, new Date(t0.getTime() + 60_000)))).toBeNull();
    expect(sent).toHaveLength(0);
    const retry = await maybeSendUsagePing('phantom', '1.0.0', base({}, new Date(t0.getTime() + 2 * 3600_000)));
    expect(retry?.event).toBe('install');
  });
});
