import { mkdirSync, utimesSync, writeFileSync, symlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebServerHandle } from '../src/core/types.js';
import { appendEvent, ownerConfigPath, requestAccess, teamState, type TeamActor } from '../src/core/teams/index.js';
import { AGENT_ENV_MARKERS } from '../src/core/teams/identity.js';
import {
  buildApprovalsProjection, decideTeamApproval, holdsConfigPath, readHolds, readStagedPins,
} from '../src/core/approvals/surface.js';
import { cmdApprovals, renderApprovals } from '../src/cli/approvals.js';
import { makeCfg, makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const mason: TeamActor = { kind: 'human', id: 'human:mason' };
const codex: TeamActor = { kind: 'agent', id: 'agent:codex/acct-2', provider: 'codex', onBehalfOf: 'human:mason' };
const T = 'approvals-surface';

let fx: H1Fixture;
let prevAshlrHome: string | undefined;
const savedEnv: Record<string, string | undefined> = {};
const servers: WebServerHandle[] = [];

beforeEach(() => {
  fx = makeFixture();
  prevAshlrHome = process.env['ASHLR_HOME'];
  process.env['ASHLR_HOME'] = fx.ashlrDir;
  for (const k of AGENT_ENV_MARKERS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  const owner = ownerConfigPath();
  mkdirSync(dirname(owner), { recursive: true });
  writeFileSync(owner, JSON.stringify({ human: 'mason' }));
  appendEvent(T, mason, 'member.joined', {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await s.close();
  if (prevAshlrHome === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = prevAshlrHome;
  for (const k of AGENT_ENV_MARKERS) if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]; else delete process.env[k];
  fx.cleanup();
});

describe('holds config', () => {
  it('is an honest empty list when the file does not exist', () => {
    expect(readHolds()).toMatchObject({ state: 'ok', configured: false, items: [] });
  });

  it('lists open holds and drops resolved ones', () => {
    writeFileSync(holdsConfigPath(), JSON.stringify({ holds: [
      { id: 'pr-197', title: 'phantom #197', detail: 'wait for Mason', since: '2026-11-01' },
      { id: 'done', title: 'old', resolvedAt: '2026-11-02' },
    ] }));
    const h = readHolds();
    expect(h.configured).toBe(true);
    expect(h.items).toEqual([{ id: 'pr-197', title: 'phantom #197', detail: 'wait for Mason', since: '2026-11-01' }]);
  });

  it('reports a malformed file as unavailable, never as empty', () => {
    writeFileSync(holdsConfigPath(), '{nope');
    expect(readHolds()).toMatchObject({ state: 'unavailable', items: [] });
    writeFileSync(holdsConfigPath(), JSON.stringify({ holds: [{ id: 'x' }] }));
    expect(readHolds().state).toBe('unavailable');
  });
});

describe('staged pin queue', () => {
  it('is empty when nothing is staged or the root is absent', () => {
    expect(readStagedPins(join(fx.home, 'nope')).items).toEqual([]);
  });

  it('lists name, files touched and age, oldest first, without following symlinks', () => {
    const root = join(fx.home, 'staged');
    mkdirSync(join(root, 'pkg-a', 'sub'), { recursive: true });
    writeFileSync(join(root, 'pkg-a', 'one.ts'), 'x');
    writeFileSync(join(root, 'pkg-a', 'sub', 'two.ts'), 'x');
    symlinkSync(fx.home, join(root, 'pkg-a', 'link'));
    mkdirSync(join(root, 'pkg-b'));
    writeFileSync(join(root, 'pkg-b', 'only.ts'), 'x');
    writeFileSync(join(root, '.hidden'), 'x');
    const now = Date.now();
    utimesSync(join(root, 'pkg-a'), new Date(now - 3 * 3_600_000), new Date(now - 3 * 3_600_000));
    const pins = readStagedPins(root, now);
    expect(pins.items.map((i) => [i.name, i.filesTouched, i.truncated])).toEqual([['pkg-a', 2, false], ['pkg-b', 1, false]]);
    expect(pins.items[0]!.ageMs).toBeGreaterThanOrEqual(3 * 3_600_000);
  });
});

describe('team approvals', () => {
  it('projects pending access requests with the CLI command, and nothing once decided', () => {
    const r = requestAccess(T, codex, { type: 'member.invited', memberId: 'human:evan' }, 'needs evan');
    const p = buildApprovalsProjection(T);
    expect(p.teamApprovals).toMatchObject({ state: 'ok' });
    expect(p.teamApprovals.items).toEqual([expect.objectContaining({
      id: r.approvalId, kind: 'access', requestedBy: codex.id, note: 'needs evan',
      command: `phm team approve ${r.approvalId} --team ${T}`,
    })]);
    expect(renderApprovals(p)).toContain(`phm team approve ${r.approvalId}`);

    expect(decideTeamApproval(T, r.approvalId, 'approve')).toMatchObject({ state: 'approved' });
    expect(buildApprovalsProjection(T).teamApprovals.items).toEqual([]);
  });

  it('refuses to decide from an agent process: the click is the approval, never an agent', () => {
    const r = requestAccess(T, codex, { type: 'member.invited', memberId: 'human:evan' });
    vi.stubEnv('CODEX_THREAD_ID', 'thread-1');
    expect(() => decideTeamApproval(T, r.approvalId, 'approve')).toThrow(/not an agent process/);
    expect(teamState(T).approvals.find((a) => a.id === r.approvalId)?.state).toBe('pending');
    vi.unstubAllEnvs();
  });

  it('reports an invalid team as unavailable, not as nothing pending', () => {
    expect(buildApprovalsProjection('../escape').teamApprovals).toMatchObject({ state: 'unavailable', items: [] });
  });
});

describe('phm approvals', () => {
  it('prints honest empty states and valid --json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdApprovals(['--team', T])).toBe(0);
    const text = String(log.mock.calls[0]![0]);
    expect(text).toContain('nothing pending');
    expect(text).toContain('nothing staged');
    expect(text).toContain('no holds configured');
    log.mockClear();
    expect(await cmdApprovals(['--team', T, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ team: T, teamApprovals: { state: 'ok', items: [] } });
  });
});

describe('/api/approvals', () => {
  async function server(allowDispatch = true) {
    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch });
    servers.push(h);
    return h;
  }
  function call(h: WebServerHandle, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: h.port, path, method, headers: {
        Host: `127.0.0.1:${h.port}`,
        ...(method === 'GET' ? readAuthHeaders(h.port) : { 'Content-Type': 'application/json', 'x-ashlr-token': h.token }),
        ...headers,
      } }, (res) => {
        let out = ''; res.setEncoding('utf8');
        res.on('data', (c: string) => { out += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  it('serves the projection and decides through the human machinery', async () => {
    const r = requestAccess(T, codex, { type: 'member.invited', memberId: 'human:evan' });
    const h = await server();
    const got = await call(h, 'GET', `/api/approvals?team=${T}`);
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body).teamApprovals.items[0].id).toBe(r.approvalId);

    const bad = await call(h, 'POST', `/api/approvals/team/${r.approvalId}/decision`, { decision: 'maybe' });
    expect(bad.status).toBe(400);
    const spoof = await call(h, 'POST', `/api/approvals/team/${r.approvalId}/decision`, { decision: 'approve', team: T, actor: 'human:x' });
    expect(spoof.status).toBe(400);
    const noToken = await call(h, 'POST', `/api/approvals/team/${r.approvalId}/decision`, { decision: 'approve', team: T }, { 'x-ashlr-token': 'wrong' });
    expect(noToken.status).toBe(401);
    expect(teamState(T).approvals[0]!.state).toBe('pending');

    const ok = await call(h, 'POST', `/api/approvals/team/${r.approvalId}/decision`, { decision: 'approve', team: T });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ state: 'approved' });
    expect(teamState(T).approvals[0]).toMatchObject({ state: 'approved', decidedBy: mason.id });
  });

  it('does not expose the decision route without --allow-dispatch', async () => {
    const h = await server(false);
    const res = await call(h, 'POST', '/api/approvals/team/abc/decision', { decision: 'approve' });
    expect(res.status).toBe(404);
  });

  it('refuses with 403 when the server runs inside an agent process', async () => {
    const r = requestAccess(T, codex, { type: 'member.invited', memberId: 'human:evan' });
    const h = await server();
    vi.stubEnv('CODEX_THREAD_ID', 'thread-1');
    const res = await call(h, 'POST', `/api/approvals/team/${r.approvalId}/decision`, { decision: 'approve', team: T });
    vi.unstubAllEnvs();
    expect(res.status).toBe(403);
    expect(teamState(T).approvals[0]!.state).toBe('pending');
  });
});
