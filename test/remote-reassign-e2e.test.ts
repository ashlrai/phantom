import { afterEach, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRemoteAccessVerifier } from '../src/core/web/remote-access.js';
import { createRemoteDeviceStore } from '../src/core/web/remote-device-store.js';
import { startRemoteReadGateway } from '../src/core/web/remote-gateway.js';
import { createRemotePairing } from '../src/core/web/remote-pairing.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { stopJob } from '../src/core/fleet/job-stop.js';

const ORIGIN = 'https://phone.example.com';
const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const DEVICE = '6335d417-61da-459d-899c-0a01c76a2f94';
const JOB = 'RQ-PHX-FAKEONE01';
const PATH = '/api/verse/fleet/runs/inbox';
const TOKEN = 'c'.repeat(64);
const CONFIG = { publicOrigin: ORIGIN, teamDomain: 'https://team.cloudflareaccess.com', audience: 'b'.repeat(64), allowedSubjects: [SUBJECT] };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'remote-reassign-e2e-'));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  // Deliberately different: command execution must retain the API's runsDir.
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'unused-runs'));
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  mkdirSync(join(root, 'queue'), { recursive: true });
  const ready = join(root, 'queue/ready.tsv');
  const original = `${JOB}\tphantom\tcodex-personal\twork\t${root}/prompt.md\n`;
  writeFileSync(ready, original);
  writeFileSync(join(root, 'queue/slots.json'), JSON.stringify({ lanes: {
    'codex-personal': { target: 1, floor: 0, ceiling: 4, held: false },
    devin: { target: 1, floor: 0, ceiling: 4, held: false },
  } }));
  const devices = createRemoteDeviceStore(root);
  devices.add({ id: DEVICE, label: 'Fake phone', subject: SUBJECT, email: 'owner@example.com',
    scopes: { read: true, act: true }, credentialId: randomBytes(32).toString('base64url'),
    publicKey: randomBytes(80).toString('base64url'), counter: 0, transports: ['internal'],
    deviceType: 'multiDevice', backedUp: true, createdAt: 1, lastUsedAt: null, revokedAt: null });
  // Only the OS boundary is fake: execute the real discovery, stop and audit code.
  const signals: [number, string | number][] = [];
  const api = createFleetRunsApi({ runsDir: root, stopJob: (id, opts) => stopJob(id, {
    ...opts, readers: { readProcesses: async () => [{ pid: 424242, command: `fake-worker ${JOB}` }] },
    kill: (pid, signal) => { signals.push([pid, signal]); }, graceMs: 0,
  }) });
  let forwarded = 0;
  const hub = createServer((req, res) => {
    forwarded++;
    void api({ token: TOKEN, allowDispatch: true } as VerseApiContext,
      req, res, (req.url ?? '').split('?')[0]!, req.method ?? '').then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => hub.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    hub.closeAllConnections();
    await new Promise<void>(resolve => hub.close(() => resolve()));
  });
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
  const verifier = createRemoteAccessVerifier(CONFIG, createLocalJWKSet({ keys: [key] }));
  const jwt = await new SignJWT({ type: 'app', email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(CONFIG.teamDomain).setAudience(CONFIG.audience)
    .setSubject(SUBJECT).setIssuedAt().setNotBefore('0s').setExpirationTime('10m').sign(privateKey);
  const gateway = await startRemoteReadGateway({ access: CONFIG, devices, verifier,
    hub: { port: (hub.address() as { port: number }).port, readToken: 'a'.repeat(64), mutationToken: TOKEN },
    pairing: createRemotePairing(CONFIG, devices) });
  cleanups.push(() => gateway.close());
  const session = gateway.issueDeviceSession({ subject: SUBJECT, email: 'owner@example.com', expiresAt: Date.now() + 600_000 }, DEVICE)!;
  async function post(text: string, paired = true) {
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest(`${gateway.url}${PATH}`, { method: 'POST', headers: {
        host: 'phone.example.com', origin: ORIGIN, 'content-type': 'application/json',
        'cf-access-jwt-assertion': jwt, 'x-ashlr-remote-csrf': session.csrfToken,
        ...(paired ? { cookie: session.cookie.split(';', 1)[0]! } : {}),
        // Untrusted browser headers must never become audit identity.
        'x-ashlr-remote-device': 'attacker', 'x-ashlr-channel': 'desktop',
      } }, res => {
        let body = '';
        res.on('data', chunk => { body += String(chunk); });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ text, source: 'untrusted source' }));
    });
  }
  return { root, ready, original, post, signals, forwarded: () => forwarded };
}

it('paired phone reassign reaches dispatcher ready.tsv exactly once with device and time audit', async () => {
  const f = await fixture();
  const before = Date.now();
  const response = await f.post(`/reassign ${JOB} devin`);
  expect(response.status).toBe(201);
  expect(response.body.command).toMatchObject({ status: 'moved' });
  // dispatchd.py reads this exact queue/ready.tsv, not an intent projection.
  const rows = readFileSync(f.ready, 'utf8').trim().split('\n').map(row => row.split('\t'));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.slice(0, 4)).toEqual([JOB, 'phantom', 'devin', 'work']);
  const audit = readFileSync(join(f.root, 'queue/reassign.log'), 'utf8').trim().split('\n');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toContain(`\t${JOB}\tcodex-personal\tdevin\tmobile-device:${DEVICE}\t`);
  expect(Date.parse(audit[0]!.split('\t')[0]!)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(audit[0]!.split('\t')[0]!)).toBeLessThanOrEqual(Date.now());
});

it('paired phone stop reaches real worker signal boundary and persists the stop receipt', async () => {
  const f = await fixture();
  const response = await f.post(`/stop ${JOB}`);
  expect(response.status).toBe(201);
  expect(response.body.command).toMatchObject({ status: 'stopped' });
  expect(f.signals).toEqual([[424242, 'SIGTERM'], [424242, 0], [424242, 'SIGKILL']]);
  const receipt = JSON.parse(readFileSync(join(f.root, 'queue/job-stops.jsonl'), 'utf8'));
  expect(receipt).toMatchObject({ id: JOB, outcome: 'stopped', pids: [424242], by: `mobile-device:${DEVICE}` });
  expect(Number.isFinite(Date.parse(receipt.at))).toBe(true);
  expect(readFileSync(f.ready, 'utf8')).toBe(f.original);
});

it('Access assertion without paired session cannot reassign or touch the queue', async () => {
  const f = await fixture();
  const response = await f.post(`/reassign ${JOB} devin`, false);
  expect([401, 403]).toContain(response.status);
  expect(f.forwarded()).toBe(0);
  expect(readFileSync(f.ready, 'utf8')).toBe(f.original);
  expect(existsSync(join(f.root, 'queue/reassign.log'))).toBe(false);
  expect(existsSync(join(f.root, 'queue/job-stops.jsonl'))).toBe(false);
  expect(f.signals).toEqual([]);
});
