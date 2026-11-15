import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OwnerAssistService, routeOwnerTurn } from '../src/core/owner-assist/service.js';
import { discoverOwnerOmlx } from '../src/core/owner-assist/seats.js';
import { createOwnerAssistApi } from '../src/core/verse/owner-assist-api.js';
import { createVerseEngine, type VerseEngineHandle } from '../src/core/verse/session-engine.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { VerseSeatDiscovery } from '../src/core/verse/seats.js';
import type { VerseSeat, VerseSession } from '../src/core/verse/types.js';
import type { AshlrConfig } from '../src/core/types.js';
import { agentToolsGrant, resetVerseMcpGrantsForTest } from '../src/core/verse/verse-mcp-grants.js';

const cfg = { version: 1, roots: [], models: {} } as AshlrConfig;
const prefs = { callsign: 'Scout', preference: 'auto' as const };
const seat = (engine: VerseSeat['engine']): VerseSeat => ({ id: engine, engine, accountId: engine, label: engine,
  models: [{ id: engine === 'local' ? 'qwen:32b' : 'claude-sonnet-4-6', label: 'Model', contextWindow: 32000 }], contextWindow: 32000,
  health: { state: 'ready', summary: null, windows: [], observedAt: null } });
const seats = [seat('local'), seat('claude')];
const discovery: VerseSeatDiscovery = { seats, localRuntime: null, launches: new Map(seats.map(s => [s.id,
  { seat: s, launcher: [process.execPath, 'fixture'], ollamaBaseUrl: 'http://127.0.0.1:1' }])) };
const turn = { projectPath: '/tmp/project', text: 'Fix the layout', tier: 'work' as const };
let temp: string;
let service: OwnerAssistService;
let engine: VerseEngineHandle;
let sessions: VerseSession[];
let killed: boolean;
let discover: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'owner-assist-'));
  await mkdir(join(temp, 'project'));
  sessions = []; killed = false;
  engine = {
    listSessions: () => sessions, getSession: id => sessions.find(s => s.id === id) ?? null,
    getEvents: () => [{ seq: 1, at: 'now', type: 'assistant-message', turnId: 'turn', text: 'Previous decision' }],
    createSession: vi.fn((req, launch) => {
      const s = { ...req, id: randomUUID(), engine: launch.seat.engine, status: 'idle', model: req.model, title: req.title } as VerseSession;
      sessions.push(s); return s;
    }),
    sendTurn: vi.fn(id => { const s = sessions.find(s => s.id === id)!; s.status = 'running'; return { turnId: 't', session: s }; }),
    cancelTurn: vi.fn(id => { sessions.find(s => s.id === id)!.status = 'idle'; return true; }),
    refreshLocalWindow: vi.fn(id => sessions.find(s => s.id === id)!), close: vi.fn(),
  } as unknown as VerseEngineHandle;
  discover = vi.fn(async () => discovery);
  service = new OwnerAssistService(join(temp, 'state'), { engine: () => engine, discover,
    killed: async () => killed, runsRoot: join(temp, 'runs') });
});
afterEach(async () => { service.close(); resetVerseMcpGrantsForTest(); await rm(temp, { recursive: true, force: true }); });
const request = () => ({ ...turn, projectPath: join(temp, 'project') });

describe('Owner Assist runtime boundaries', () => {
  it('discovers only advertised oMLX Qwen chat models and prefers provisioned 27B+ models', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'Qwen3-8B', owned_by: 'omlx', max_model_len: 32768 },
      { id: 'Qwen3.5-27B', owned_by: 'omlx', max_model_len: 65536 },
      { id: 'Qwen3-Embedding', owned_by: 'omlx' }, { id: 'Qwen3-32B', owned_by: 'other' },
    ] }))) as unknown as typeof fetch;
    const found = await discoverOwnerOmlx(8000, fetcher);
    expect(found.map(s => s.models[0]?.id)).toEqual(['Qwen3.5-27B', 'Qwen3-8B']);
    expect(found[0]?.contextWindow).toBe(65536);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8000/v1/models', expect.objectContaining({ redirect: 'error' }));
    expect(await discoverOwnerOmlx(65536, fetcher)).toEqual([]);
  });
  it('does not turn unavailable or oversized local metadata into a runnable model', async () => {
    expect(await discoverOwnerOmlx(8000, vi.fn(async () => new Response('x'.repeat(131073))) as typeof fetch)).toEqual([]);
    expect(await discoverOwnerOmlx(8000, vi.fn(async () => new Response('', { status: 401 })) as typeof fetch)).toEqual([]);
  });
  it('routes trivial work locally, non-trivial work to the best API seat, and honors explicit choices', () => {
    expect(routeOwnerTurn(discovery, turn, prefs).launch.seat.engine).toBe('claude');
    expect(routeOwnerTurn(discovery, { ...turn, tier: 'fast' }, prefs).launch.seat.engine).toBe('local');
    expect(routeOwnerTurn(discovery, { ...turn, tier: 'frontier' }, prefs).launch.seat.engine).toBe('claude');
    expect(routeOwnerTurn(discovery, { ...turn, preference: 'local', tier: 'frontier' }, prefs).launch.seat.engine).toBe('local');
    expect(routeOwnerTurn(discovery, { ...turn, preference: 'api', tier: 'fast' }, prefs).launch.seat.engine).toBe('claude');
    expect(routeOwnerTurn(discovery, { ...turn, seatId: 'local' }, prefs).launch.seat.engine).toBe('local');
    expect(() => routeOwnerTurn({ ...discovery, seats: [seats[1]!] }, { ...turn, preference: 'local' }, prefs)).toThrow('No available seat');
    expect(() => routeOwnerTurn({ ...discovery, seats: [seats[0]!] }, { ...turn, preference: 'api' }, prefs)).toThrow('No available seat');
    expect(() => routeOwnerTurn(discovery, { ...turn, seatId: 'missing' }, prefs)).toThrow('No available seat');
  });
  it('explains which model answered and flags honest auto fallback across classes', () => {
    const routed = routeOwnerTurn(discovery, turn, prefs);
    expect(routed.routing).toMatchObject({ preference: 'auto', tier: 'work', class: 'api', seatId: 'claude',
      model: 'claude-sonnet-4-6', fellBack: false });
    expect(routed.routing.reason).toContain('API seat');
    const noApi = { ...discovery, seats: [seats[0]!] };
    const fellBack = routeOwnerTurn(noApi, turn, prefs);
    expect(fellBack.routing).toMatchObject({ class: 'local', fellBack: true });
    expect(fellBack.routing.reason).toContain('no API seat');
    const noLocal = { ...discovery, seats: [seats[1]!] };
    const quick = routeOwnerTurn(noLocal, { ...turn, tier: 'fast' }, prefs);
    expect(quick.routing).toMatchObject({ class: 'api', fellBack: true });
    expect(quick.routing.reason).toContain('no local seat');
    expect(routeOwnerTurn(discovery, { ...turn, seatId: 'local' }, prefs).routing)
      .toMatchObject({ class: 'local', fellBack: false, reason: expect.stringContaining('You chose') });
  });
  it('keeps owner concurrency independent and admits only one turn including during async discovery', async () => {
    let release!: () => void;
    discover.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return discovery; });
    const first = service.send(request(), cfg, 'http://127.0.0.1:7777');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(service.send(request(), cfg, 'http://127.0.0.1:7777')).rejects.toMatchObject({ code: 'VERSE_SESSION_BUSY' });
    release(); const result = await first;
    expect(agentToolsGrant(result.session.id).terminal).toBe('agent');
    expect(agentToolsGrant(result.session.id).computer).toBe('off');
    await expect(service.send(request(), cfg, 'http://127.0.0.1:7777')).rejects.toMatchObject({ code: 'VERSE_SESSION_BUSY' });
    expect(await service.handoffs()).toEqual([]);
    service.cancel(result.session.id);
    await service.send({ ...request(), sessionId: result.session.id }, cfg, 'http://127.0.0.1:7777');
    expect(engine.createSession).toHaveBeenCalledTimes(1);
  });
  it('hands conversation context across model changes and grants shared memory', async () => {
    const first = await service.send({ ...request(), preference: 'local' }, cfg, 'http://127.0.0.1:7777');
    service.cancel(first.session.id);
    const next = await service.send({ ...request(), sessionId: first.session.id, preference: 'api' }, cfg, 'http://127.0.0.1:7777');
    expect(next.session.id).not.toBe(first.session.id);
    expect(engine.sendTurn).toHaveBeenLastCalledWith(next.session.id, expect.stringContaining('Previous decision'));
    expect(engine.createSession).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ memory: expect.objectContaining({ writable: true }) }));
  });
  it('answers turns with their routing record and resumes the last conversation after a restart', async () => {
    const first = await service.send(request(), cfg, 'http://127.0.0.1:7777');
    expect(first.routing).toMatchObject({ class: 'api', seatId: 'claude', model: 'claude-sonnet-4-6', fellBack: false });
    service.cancel(first.session.id);
    const snapshot = await service.snapshot(cfg);
    expect(snapshot.resumeSessionId).toBe(first.session.id);
    expect(snapshot.routing[first.session.id]).toMatchObject({ model: 'claude-sonnet-4-6', reason: expect.stringContaining('API seat') });
    expect((await stat(join(temp, 'state', 'owner-assist.state.json'))).mode & 0o777).toBe(0o600);
    const restarted = new OwnerAssistService(join(temp, 'state'), { engine: () => engine, discover });
    const again = await restarted.snapshot(cfg);
    expect(again.resumeSessionId).toBe(first.session.id);
    expect(again.routing[first.session.id]?.reason).toContain('API seat');
    sessions.length = 0;
    expect((await restarted.snapshot(cfg)).resumeSessionId).toBeUndefined();
    await writeFile(join(temp, 'state', 'owner-assist.state.json'), '{broken');
    await expect(restarted.snapshot(cfg)).rejects.toThrow();
    expect(await readFile(join(temp, 'state', 'owner-assist.state.json'), 'utf8')).toBe('{broken');
    restarted.close();
  });
  it('refuses unknown sessions, protected roots, symlink escapes, KILL and unknown input keys', async () => {
    await expect(service.send({ ...request(), sessionId: randomUUID() }, cfg, 'http://127.0.0.1:7777')).rejects.toMatchObject({ code: 'VERSE_SESSION_NOT_FOUND' });
    await expect(service.send({ ...request(), projectPath: homedir() }, cfg, 'http://127.0.0.1:7777')).rejects.toMatchObject({ code: 'VERSE_INVALID' });
    await symlink(homedir(), join(temp, 'escape'));
    await expect(service.send({ ...request(), projectPath: join(temp, 'escape') }, cfg, 'http://127.0.0.1:7777')).rejects.toMatchObject({ code: 'VERSE_INVALID' });
    killed = true;
    await expect(service.send(request(), cfg, 'http://127.0.0.1:7777')).rejects.toThrow('KILL');
    await expect(service.send({ ...request(), bypass: true }, cfg, 'http://127.0.0.1:7777')).rejects.toThrow();
    expect(engine.sendTurn).not.toHaveBeenCalled();
  });
  it('persists identity and memory privately and refuses corrupt or oversized state', async () => {
    await service.configure(prefs); await service.remember({ text: 'Project: weyv. Prefer focused diffs.' });
    const restarted = new OwnerAssistService(join(temp, 'state'), { engine: () => engine, discover });
    expect(await restarted.snapshot(cfg)).toMatchObject({ scope: 'owner', concurrency: 1, preferences: prefs, memory: 'Project: weyv. Prefer focused diffs.' });
    expect((await stat(join(temp, 'state', 'owner-assist.json'))).mode & 0o777).toBe(0o600);
    await writeFile(join(temp, 'state', 'owner-assist.json'), '{broken');
    await expect(restarted.snapshot(cfg)).rejects.toThrow();
    expect(await readFile(join(temp, 'state', 'owner-assist.json'), 'utf8')).toBe('{broken');
    await expect(service.remember({ text: 'x'.repeat(24001) })).rejects.toThrow();
    await expect(service.remember({ text: '[REDACTED]' })).rejects.toThrow('Redacted memory');
  });
  it('only explicit handoff creates a proper job, deduplicates retries, and projects the recorded PR', async () => {
    const task = { id: `RQ-OWNER-${randomUUID()}`, repo: 'ashlrai/phantom', scope: 'Fix the widget', acceptance: 'Tests pass', tier: 'work' };
    const receipt = await service.handoff(task);
    expect(receipt).toMatchObject({ status: 'SUBMITTED' });
    const file = join(temp, 'runs/leader/drop/claude', `${receipt.fleetJobId}.md`);
    expect(await readFile(file, 'utf8')).toContain('#job repo=phantom lane=codex-personal tier=work');
    await service.handoff(task);
    expect(await service.handoffs()).toHaveLength(1);
    await writeFile(join(temp, 'runs', `${receipt.fleetJobId}.publish`), 'RESULT PR https://github.com/ashlrai/phantom/pull/1\n');
    expect(await service.handoffs()).toEqual([expect.objectContaining({ status: 'PR-OPEN', prUrl: 'https://github.com/ashlrai/phantom/pull/1' })]);
    await expect(service.handoff({ ...task, scope: 'Different task' })).rejects.toThrow('different task');
    await expect(service.handoff({ ...task, id: `RQ-OWNER-${randomUUID()}`, repo: 'ashlrai/weyv' })).rejects.toThrow('currently supports');
    await expect(service.handoff({ ...task, id: `RQ-OWNER-${randomUUID()}`, scope: 'Change .github/workflows' })).rejects.toThrow('denied-content');
    await expect(service.handoff({ ...task, id: `RQ-OWNER-${'-'.repeat(36)}` })).rejects.toThrow();
    await rm(file);
    await rm(join(temp, 'runs', `${receipt.fleetJobId}.publish`));
    expect(await service.handoff(task)).toMatchObject({ status: 'UNOBSERVED' });
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('stays fleet-isolated: owner-assist modules reach fleet state only through the sanctioned drop/projection readers', async () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '../src/core');
    // Fleet reach for the service modules is exactly the drop writer and the
    // two read-only evidence projections; the HTTP module has no fleet reach.
    const allowed = /^node:|^zod$|^\.\/|^\.\.\/types\.js$|^\.\.\/util\/|^\.\.\/verse\/|^\.\.\/queue\/(store|schema)\.js$|^\.\.\/fleet\/(drop-job-writer|drop-job-fate|runs-parked-queue)\.js$/;
    const apiAllowed = /^zod$|^\.\.\/web\/api\.js$|^\.\.\/owner-assist\/service\.js$|^\.\//;
    const files = (await readdir(join(src, 'owner-assist'))).filter(f => f.endsWith('.ts')).map(f => join(src, 'owner-assist', f));
    files.push(join(src, 'verse', 'owner-assist-api.ts'));
    for (const file of files) {
      const rules = file.endsWith('owner-assist-api.ts') ? apiAllowed : allowed;
      const specifiers = [...(await readFile(file, 'utf8')).matchAll(/from '([^']+)'/g)].map(m => m[1]!);
      for (const specifier of specifiers) expect(rules.test(specifier), `${file} must not import ${specifier}`).toBe(true);
    }
    expect(files.length).toBeGreaterThan(3);
  });
  it('links a handoff to its conversation, keeps it on retries, and refuses unknown or moved sessions', async () => {
    const sent = await service.send(request(), cfg, 'http://127.0.0.1:7777');
    service.cancel(sent.session.id);
    const task = { id: `RQ-OWNER-${randomUUID()}`, repo: 'ashlrai/phantom', scope: 'Fix the widget', acceptance: 'Tests pass',
      tier: 'work' as const, sessionId: sent.session.id };
    const receipt = await service.handoff(task);
    expect(receipt).toMatchObject({ status: 'SUBMITTED', sessionId: sent.session.id, sourceTitle: sent.session.title });
    expect(receipt.submittedAt).toBeTypeOf('string');
    expect((await service.handoffs())[0]).toMatchObject({ sessionId: sent.session.id, sourceTitle: sent.session.title, submittedAt: receipt.submittedAt });
    const second = await service.send({ ...request(), preference: 'local' }, cfg, 'http://127.0.0.1:7777');
    await expect(service.handoff({ ...task, sessionId: second.session.id })).rejects.toThrow('different task');
    await expect(service.handoff({ ...task, id: `RQ-OWNER-${randomUUID()}`, sessionId: randomUUID() })).rejects.toMatchObject({ code: 'VERSE_SESSION_NOT_FOUND' });
    await expect(service.handoff({ ...task, id: `RQ-OWNER-${randomUUID()}`, sessionId: 'not-a-uuid' })).rejects.toThrow();
  });
  it('projects only recorded completion and refuses handoff while KILL is engaged', async () => {
    const task = { id: `RQ-OWNER-${randomUUID()}`, repo: 'ashlrai/phantom', scope: 'Fix the widget', acceptance: 'Tests pass', tier: 'work' };
    killed = true;
    await expect(service.handoff(task)).rejects.toThrow('KILL');
    expect(await service.handoffs()).toEqual([]);
    killed = false;
    const receipt = await service.handoff(task);
    await mkdir(join(temp, 'runs/metrics'));
    const log = join(temp, 'runs/metrics/jobs.jsonl');
    await writeFile(log, JSON.stringify({ job: receipt.fleetJobId, event: 'outcome', state: 'FAILED', url: 'https://evil.invalid/pull/1' }));
    expect((await service.handoffs())[0]).toMatchObject({ status: 'FINISHED' });
    expect((await service.handoffs())[0]?.prUrl).toBeUndefined();
    await writeFile(log, JSON.stringify({ job: receipt.fleetJobId, event: 'outcome', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/7' }));
    expect((await service.handoffs())[0]).toMatchObject({ status: 'MERGED', prUrl: 'https://github.com/ashlrai/phantom/pull/7' });
  });
  it('uses the real Verse runtime to edit a selected project and persist its transcript outside fleet state', async () => {
    const cli = join(temp, 'fixture.cjs');
    await writeFile(cli, `require('fs').writeFileSync('owner-output.txt','edited'); console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Edited project'}]}})); console.log(JSON.stringify({type:'result',subtype:'success',result:'Edited project',session_id:'fixture',is_error:false}));`);
    const localDiscovery = { ...discovery, seats: [seats[1]!], launches: new Map([['claude', { ...discovery.launches.get('claude')!, launcher: [process.execPath, cli] }]]) };
    service.close();
    service = new OwnerAssistService(join(temp, 'real'), { discover: async () => localDiscovery, killed: async () => false,
      engine: root => createVerseEngine({ root, readiness: null, reasoningTap: null, preflight: null, processRegistry: false, loadConfig: () => cfg }) });
    const result = await service.send({ ...request(), preference: 'api' }, cfg, 'http://127.0.0.1:7777');
    await vi.waitFor(() => expect(service.detail(result.session.id).session.status).not.toBe('running'));
    expect(await readFile(join(temp, 'project', 'owner-output.txt'), 'utf8')).toBe('edited');
    expect(service.detail(result.session.id).events).toContainEqual(expect.objectContaining({ type: 'assistant-message', text: 'Edited project' }));
    service.close();
    expect(service.detail(result.session.id).session.model).toBe('claude-sonnet-4-6');
  });
});

describe('Owner Assist API', () => {
  async function call(method: string, suffix = '', body: unknown = {}, options: { read?: boolean; dispatch?: boolean; token?: string } = {}) {
    const path = '/api/verse/owner-assist' + suffix;
    const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
    req.url = path; req.headers = { 'content-type': 'application/json', 'x-ashlr-token': options.token ?? 'test-operator' };
    Object.defineProperty(req, 'socket', { value: { localPort: 7777 } });
    let status = 0; let data: unknown;
    const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { data = JSON.parse(text); } }) as unknown as ServerResponse;
    await createOwnerAssistApi(() => service)({ cfg, token: 'test-operator', allowDispatch: options.dispatch ?? true,
      ...(options.read === false ? {} : { readSession: { id: 'reader', expiresAt: Date.now() + 60000 } }) } as VerseApiContext, req, res, path, method);
    return { status, data };
  }
  it('requires read authority and mutation authority, even for cancel or preferences', async () => {
    expect((await call('GET', '', {}, { read: false })).status).toBe(401);
    expect((await call('POST', '/preferences', prefs, { token: 'wrong' })).status).toBe(401);
    expect((await call('POST', '/turns', request(), { dispatch: false })).status).toBe(404);
    expect(engine.sendTurn).not.toHaveBeenCalled();
  });
  it('returns JSON snapshots without launch records and refuses unknown fields', async () => {
    const result = await call('GET');
    expect(result.status).toBe(200); expect(JSON.stringify(result.data)).not.toContain('launcher');
    expect((await call('POST', '/preferences', { ...prefs, command: 'sh' })).status).toBe(400);
    expect((await call('POST', '/turns', { ...request(), extraRoots: ['/'] })).status).toBe(400);
    expect((await call('GET', '/missing')).status).toBe(404);
  });
});
