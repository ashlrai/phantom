/** Gateway sessions: revoke blocks the next call, arguments are redacted, the log rotates at 14 days. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activityLogPath, isGatewaySessionAllowed, listGatewaySessions, readGatewayActivity, recordGatewayActivity,
  registerGatewaySession, revokeGatewaySession, rotateGatewayActivity,
} from '../src/core/gateway-sessions.js';
import { cmdSessions } from '../src/cli/sessions.js';

let home: string;
let saved: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gateway-session-revoke-'));
  saved = process.env.ASHLR_HOME;
  process.env.ASHLR_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ASHLR_HOME; else process.env.ASHLR_HOME = saved;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const DAY = 24 * 60 * 60 * 1000;
// Key-like value assembled at runtime, never written as one literal.
const keyLike = (): string => ['sk', 'ant', 'api03', 'ABCDEFGH12345678', 'ijklmnop90123456'].join('-');

describe('revoke blocks the next call', () => {
  it('allows a fresh session, then refuses it once revoked', () => {
    const s = registerGatewaySession({ agent: 'codex', groups: ['eng'] });
    expect(s.id).toMatch(/^gs_[0-9a-f]{12}$/);
    expect(isGatewaySessionAllowed(s.id)).toBe(true);
    const r = revokeGatewaySession(s.id);
    expect(r).toMatchObject({ ok: true, alreadyRevoked: false });
    expect(isGatewaySessionAllowed(s.id)).toBe(false);
    expect(revokeGatewaySession(s.id)).toMatchObject({ ok: true, alreadyRevoked: true });
  });

  it('treats a missing record as revoked and rejects bad ids', () => {
    const s = registerGatewaySession({ groups: [] });
    rmSync(join(home, 'gateway', 'sessions', `${s.id}.json`));
    expect(isGatewaySessionAllowed(s.id)).toBe(false);
    expect(revokeGatewaySession('../../etc/passwd')).toEqual({ ok: false, reason: 'invalid-id' });
    expect(revokeGatewaySession('gs_000000000000')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('CLI list and revoke work with --json', async () => {
    const s = registerGatewaySession({ agent: 'codex', groups: [] });
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); });
    expect(await cmdSessions(['list', '--json'])).toBe(0);
    expect(JSON.parse(out[0]).sessions[0]).toMatchObject({ id: s.id, caller: 'codex', status: 'active' });
    expect(await cmdSessions(['revoke', s.id, '--json'])).toBe(0);
    expect(JSON.parse(out[1])).toMatchObject({ ok: true, alreadyRevoked: false });
    expect(listGatewaySessions()[0].status).toBe('revoked');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdSessions(['revoke', 'gs_000000000000'])).toBe(1);
    expect(await cmdSessions(['revoke'])).toBe(2);
  });
});

describe('activity log redaction', () => {
  it('records caller, tool and verdict but no argument values', () => {
    const key = keyLike();
    recordGatewayActivity({ session: 'gs_aaaaaaaaaaaa', caller: 'codex', tool: 'locus__status', verdict: 'allow', args: { token: key, path: '/private/notes.txt' } });
    const text = readFileSync(activityLogPath(), 'utf8');
    expect(text).not.toContain(key);
    expect(text).not.toContain('/private/notes.txt');
    const [row] = readGatewayActivity();
    expect(row).toMatchObject({ session: 'gs_aaaaaaaaaaaa', caller: 'codex', tool: 'locus__status', verdict: 'allow', args: { path: '[redacted]', token: '[redacted]' } });
  });

  it('scrubs a key-like argument name', () => {
    const key = keyLike();
    recordGatewayActivity({ session: 'gs_aaaaaaaaaaaa', caller: 'codex', tool: 'x__y', verdict: 'deny', args: { [key]: 1 } });
    expect(readFileSync(activityLogPath(), 'utf8')).not.toContain(key);
  });
});

describe('14-day rotation', () => {
  it('drops older rows, keeps newer ones, and prunes old finished sessions', () => {
    const now = new Date('2026-11-02T00:00:00Z');
    const row = (at: Date, tool: string) => JSON.stringify({ ts: at.toISOString(), session: 'gs_aaaaaaaaaaaa', caller: 'c', tool, verdict: 'allow', args: {} });
    registerGatewaySession({ groups: [] }); // creates the directory
    writeFileSync(activityLogPath(), [
      row(new Date(now.getTime() - 15 * DAY), 'old__a'),
      row(new Date(now.getTime() - 13 * DAY), 'new__b'),
      'not json',
    ].join('\n') + '\n');
    const gone = registerGatewaySession({ groups: [] }, new Date(now.getTime() - 20 * DAY));
    revokeGatewaySession(gone.id, new Date(now.getTime() - 16 * DAY));
    expect(rotateGatewayActivity(now)).toBe(1);
    expect(readGatewayActivity().map(r => r.tool)).toEqual(['new__b']);
    expect(listGatewaySessions().some(s => s.id === gone.id)).toBe(false);
  });
});
