import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { summarizePhoneActivity } from '../src/core/web/phone-activity-summary.js';
import { phonePairingPayload, phonePairingQr, phoneQrFormatBits } from '../src/core/web/phone-pairing-qr.js';
import { phoneRoutePermission } from '../src/core/web/phone-permissions.js';
import { createPhoneSessionCustody } from '../src/core/web/phone-session-custody.js';
import { createRemoteDeviceStore } from '../src/core/web/remote-device-store.js';
import { startRemoteReadGateway } from '../src/core/web/remote-gateway.js';
import { createRemotePairing } from '../src/core/web/remote-pairing.js';
import { PhoneGatewayKilledError, startRemoteRuntime } from '../src/core/web/remote-runtime.js';
import { summarizeWorldForPhone } from '../src/core/web/phone-world-summary.js';
import { projectWorldModel } from '../src/core/world/project.js';

const ORIGIN = 'https://phone.example.com';
const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const CONFIG = {
  publicOrigin: ORIGIN,
  teamDomain: 'https://team.cloudflareaccess.com',
  audience: 'a'.repeat(64),
  allowedSubjects: [SUBJECT],
};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'phone-view-'));
  roots.push(root);
  return root;
}

describe('phone watch summary', () => {
  it('keeps unknown world fields null and reports a measured zero', () => {
    const now = Date.parse('2026-11-09T12:00:00.000Z');
    const model = projectWorldModel({
      nowMs: now,
      sensors: null,
      roster: null,
      claims: null,
      busReadable: null,
      queue: null,
      ci: null,
      updatePhase: null,
      bottlenecks: 0,
      bottlenecksObservedAt: new Date(now).toISOString(),
      stepsRemaining: null,
      stepsObservedAt: null,
      outcomes: null,
    });
    const summary = summarizeWorldForPhone(model);
    expect(summary?.bottlenecks).toEqual({ value: 0, freshness: 'fresh' });
    expect(summary?.pulls).toEqual([]);
    expect(summarizeWorldForPhone({ ...model, outcomes: undefined })?.pulls).toBeNull();
    expect(summary?.releases.updateCheck.value).toBeNull();
    expect(JSON.stringify(summary)).not.toMatch(/"value":0,"freshness":"unknown"/);
    expect(summarizeWorldForPhone({ schema: 'other' })).toBeNull();
  });

  it('treats a missing activity list as unknown and an empty list as empty', () => {
    expect(summarizePhoneActivity({})).toBeNull();
    expect(summarizePhoneActivity({
      running: [{ sessionId: 's1', title: 'Ship the phone view' }],
      completions: [],
    })).toEqual({ running: [{ sessionId: 's1', title: 'Ship the phone view' }], recent: [] });
  });
});

describe('phone auth, pairing expiry, and permissions', () => {
  it('refuses an expired pairing code and an expired QR', async () => {
    let time = 1_000;
    const pairing = createRemotePairing(CONFIG, createRemoteDeviceStore(tempRoot()), { now: () => time });
    const invite = pairing.mac.issueInvitation(SUBJECT, { read: true, act: false });
    expect(invite).not.toBeNull();
    const code = invite!.code;
    expect(phonePairingQr(ORIGIN, code, invite!.expiresAt, time)?.payload).toBe(`${ORIGIN}/verse/m/#/pair/${code}`);
    time = invite!.expiresAt;
    expect(phonePairingPayload(ORIGIN, code, invite!.expiresAt, time)).toBeNull();
    expect(await pairing.phone.claimInvitation(
      { subject: SUBJECT, email: 'owner@example.com', expiresAt: time + 60_000 },
      code,
      'Phone',
    )).toBeNull();
  });

  it('lets a read device read the world and blocks it from sending', () => {
    const read = { read: true, act: false };
    const act = { read: true, act: true };
    expect(phoneRoutePermission(read, 'GET', '/api/verse/world')).toBe('allow');
    expect(phoneRoutePermission(read, 'GET', '/api/verse/activity')).toBe('allow');
    expect(phoneRoutePermission(read, 'POST', '/api/verse/leader/thread')).toBe('deny');
    expect(phoneRoutePermission(act, 'POST', '/api/verse/leader/thread')).toBe('allow');
    expect(phoneRoutePermission(act, 'POST', '/api/verse/world')).toBe('deny');
    expect(phoneRoutePermission({ read: false, act: true }, 'GET', '/api/verse/world')).toBe('deny');
  });

  it('stores the session as a Phantom Secrets handle and drops it after expiry', () => {
    let time = 5_000;
    const custody = createPhoneSessionCustody(tempRoot(), () => time);
    const token = 'a'.repeat(43);
    const issued = custody.issue({
      deviceId: '7335d417-61da-459d-899c-0a01c76a2f94',
      subject: SUBJECT,
      scope: 'read',
      expiresAt: 10_000,
      token,
    });
    expect(issued.handle).toMatch(/^phm_phone_session_[a-f0-9]{32}$/);
    const file = readFileSync(custody.path, 'utf8');
    expect(file).toContain(issued.handle);
    expect(file).not.toContain(token);
    expect(custody.tokenFor(issued.handle)).toBe(token);
    time = 10_000;
    expect(custody.tokenFor(issued.handle)).toBeNull();
    expect(custody.list()).toEqual([]);
  });

  it('refuses phone traffic while KILL is set and still binds loopback when it listens', async () => {
    await expect(startRemoteRuntime('/no-such-config', {
      port: 1, readToken: 'a'.repeat(64), token: 'b'.repeat(64),
    }, { killed: () => true })).rejects.toBeInstanceOf(PhoneGatewayKilledError);

    const gateway = await startRemoteReadGateway({
      access: CONFIG,
      hub: { port: 9, readToken: 'c'.repeat(64) },
      devices: createRemoteDeviceStore(tempRoot()),
      verifier: async () => null,
      killed: () => true,
    });
    expect(gateway.url.startsWith('http://127.0.0.1:')).toBe(true);
    const response = await fetch(`${gateway.url}/api/verse/world`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'PHONE_DISABLED' });
    await gateway.close();
  });

  it('builds a scannable pairing QR with the standard format bits', () => {
    expect(phoneQrFormatBits()).toBe(0b111011111000100);
    const code = 'A'.repeat(43);
    const qr = phonePairingQr(ORIGIN, code, 2_000, 1_000);
    expect(qr?.svg.startsWith('<svg')).toBe(true);
    expect(qr?.ascii).toContain('██');
    expect(qr?.payload.endsWith(`#/pair/${code}`)).toBe(true);
  });
});
