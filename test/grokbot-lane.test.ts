import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, realpath, rm, writeFile, symlink, mkdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTask, type GrokbotTask } from '../src/core/resources/grokbot/contract.js';
import { parseSnapshot, reserveTask, type GrokUltraSnapshot } from '../src/core/resources/grokbot/ledger.js';
import { GrokbotLane } from '../src/core/resources/grokbot/lane.js';
import { postGrokbotTask, sendViaPhantomExec } from '../src/core/resources/grokbot/transport.js';
import { spawn } from 'node:child_process';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
let root: string;
let server: Server | undefined;
const now = Date.parse('2026-10-26T12:00:00.000Z');
const caps = { day: 3, week: 5 };
function snapshot(): GrokUltraSnapshot {
  return { schema: 'grok-ultra-budget.v1', pool: 'grok-ultra', observed_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(), not_before: new Date(now).toISOString(),
    day: { start: '2026-10-26T00:00:00.000Z', end: '2026-10-27T00:00:00.000Z', used: 0, cap: 3 },
    week: { start: '2026-10-26T00:00:00.000Z', end: '2026-11-02T00:00:00.000Z', used: 0, cap: 5 } };
}
function task(id = 'task-1'): GrokbotTask {
  return { schema: 'grokbot-task.v1', id, kind: 'connector', goal: 'Find the requested Gmail thread',
    inputs: { connector: 'gmail', thread_id: 'thread-42' }, budget_cap: 1,
    reply_to: join(root, 'replies', `${id}.json`), deadline: new Date(now + 60_000).toISOString() };
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'grokbot-lane-')));
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function stub(status = 202, location?: string): Promise<{ url: string; requests: Array<{ body: string; id: string | undefined }> }> {
  const requests: Array<{ body: string; id: string | undefined }> = [];
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    requests.push({ body, id: req.headers['idempotency-key'] as string | undefined });
    if (status === 0) return;
    res.writeHead(status, location ? { Location: location } : {}); res.end();
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture bind failed');
  return { url: `http://127.0.0.1:${address.port}/grokbot/_phantom/fixture/`, requests };
}
describe('grokbot contract and loopback webhook', () => {
  it('posts the exact payload and idempotency key to a loopback stub', async () => {
    const fixture = await stub();
    await postGrokbotTask(task(), fixture.url, now);
    expect(fixture.requests).toHaveLength(1);
    expect(JSON.parse(fixture.requests[0].body)).toEqual(task());
    expect(fixture.requests[0].id).toBe('task-1');
    expect(fixture.requests[0].body).not.toContain('fixture');
  });
  it.each(['coding', 'research', 'inference', 'shell', '', '__proto__'])('refuses kind %s before network I/O', async kind => {
    const fixture = await stub();
    await expect(postGrokbotTask({ ...task(), kind } as GrokbotTask, fixture.url, now)).rejects.toThrow('invalid-task');
    expect(fixture.requests).toHaveLength(0);
  });
  it.each(['connector', 'browser', 'desktop', 'message-mason', 'approval'])('accepts allowlisted kind %s', kind => {
    expect(parseTask({ ...task(), kind }, now).kind).toBe(kind);
  });
  it.each([
    { goal: 'Bearer synthetic-credential' }, { inputs: { api_key: 'synthetic' } },
    { goal: 'phm_fake_reference' }, { budget_cap: 2 }, { reply_to: '../escape' },
    { deadline: new Date(now).toISOString() }, { extra: true }, { goal: 'x'.repeat(17000) },
  ])('refuses unsafe or malformed payload %#', change => {
    expect(() => parseTask({ ...task(), ...change }, now)).toThrow('grokbot:');
  });
  it('refuses redirects without following them', async () => {
    const fixture = await stub(302, 'http://127.0.0.1:1/credential-sink');
    await expect(postGrokbotTask(task(), fixture.url, now)).rejects.toThrow('delivery-uncertain');
    expect(fixture.requests).toHaveLength(1);
  });
  it('retains HTTP failure as uncertain without exposing response data', async () => {
    const fixture = await stub(500);
    await expect(postGrokbotTask(task(), fixture.url, now)).rejects.toThrow('delivery-uncertain');
  });
  it('bounds a stalled webhook by the task deadline', async () => {
    const fixture = await stub(0);
    await expect(postGrokbotTask({ ...task(), deadline: new Date(now + 50).toISOString() }, fixture.url, now))
      .rejects.toThrow('delivery-uncertain');
  });
  it.each([undefined, 'phm_placeholder', 'https://example.invalid/hook', 'http://localhost:99/grokbot/',
    'http://127.0.0.1:99/grokbot/_phantom/fixture/?token=value'])('refuses unavailable or unsafe proxy routes', async url => {
    await expect(postGrokbotTask(task(), url, now)).rejects.toThrow('secrets-route-unavailable');
  });
});
describe('durable grok-ultra admission', () => {
  it('enforces daily cap across independent callers and refuses duplicate IDs', async () => {
    for (let i = 0; i < 3; i++) await reserveTask(root, `task-${i}`, now, async () => snapshot(), caps);
    await expect(reserveTask(root, 'task-3', now, async () => snapshot(), caps)).rejects.toThrow('day-cap');
    await expect(reserveTask(root, 'task-1', now, async () => snapshot(), caps)).rejects.toThrow('duplicate-task');
  });
  it('enforces weekly usage and the tighter local cap', async () => {
    const budget = snapshot(); budget.week.used = 5;
    await expect(reserveTask(root, 'weekly', now, async () => budget, caps)).rejects.toThrow('week-cap');
    await expect(reserveTask(root, 'zero', now, async () => snapshot(), { day: 0, week: 5 })).rejects.toThrow('day-cap');
  });
  it('serializes concurrent reservations without overspending', async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      reserveTask(root, `parallel-${i}`, now, async () => snapshot(), { day: 1, week: 1 })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, 'reservations.json'), 'utf8'))).toHaveLength(1);
  });
  it('keeps weekly reservations when the day rolls over', async () => {
    await reserveTask(root, 'yesterday', now, async () => snapshot(), { day: 1, week: 1 });
    const tomorrow = now + 86_400_000;
    const budget = snapshot();
    budget.observed_at = new Date(tomorrow).toISOString(); budget.expires_at = new Date(tomorrow + 60_000).toISOString();
    budget.day = { ...budget.day, start: budget.day.end, end: '2026-10-28T00:00:00.000Z' };
    await expect(reserveTask(root, 'today', tomorrow, async () => budget, { day: 1, week: 1 })).rejects.toThrow('week-cap');
  });
  it('refuses pacing, stale and malformed ledger observations', () => {
    expect(() => parseSnapshot({ ...snapshot(), not_before: new Date(now + 1).toISOString() }, now)).toThrow('ledger-paced');
    expect(() => parseSnapshot(snapshot(), now + 300_001)).toThrow('ledger-unavailable');
    expect(() => parseSnapshot({ ...snapshot(), week: { ...snapshot().week, cap: -1 } }, now)).toThrow('ledger-unavailable');
    expect(() => parseSnapshot({}, now)).toThrow('ledger-unavailable');
  });
  it('bounds the durable store without forgetting replay IDs', async () => {
    const rows = Array.from({ length: 4096 }, (_, i) => ({ id: `old-${i}`, at: '2026-10-01T00:00:00.000Z' }));
    await writeFile(join(root, 'reservations.json'), JSON.stringify(rows));
    await expect(reserveTask(root, 'new', now, async () => snapshot(), caps)).rejects.toThrow('reservation-store-full');
    await expect(reserveTask(root, 'old-0', now, async () => snapshot(), caps)).rejects.toThrow('duplicate-task');
  });
  it('does not surface ledger reader diagnostics', async () => {
    await expect(reserveTask(root, 'reader-failed', now, async () => { throw new Error('private diagnostic'); }, caps))
      .rejects.toThrow(/^grokbot: ledger-unavailable$/);
  });
  it('fails closed on corrupt state, symlinks and interrupted reservation locks', async () => {
    await writeFile(join(root, 'reservations.json'), '{');
    await expect(reserveTask(root, 'corrupt', now, async () => snapshot(), caps)).rejects.toThrow();
    await rm(join(root, 'reservations.json'));
    await symlink(join(root, 'outside.json'), join(root, 'reservations.json'));
    await expect(reserveTask(root, 'symlink', now, async () => snapshot(), caps)).rejects.toThrow();
    await mkdir(join(root, 'reservation.lock'));
    await expect(reserveTask(root, 'locked', now, async () => snapshot(), caps)).rejects.toThrow('ledger-busy');
  });
});
describe('Secrets child and daemon seam', () => {
  function child(exitCode: number) {
    const process = Object.assign(new EventEmitter(), { stdin: new PassThrough() });
    vi.mocked(spawn).mockImplementationOnce(() => {
      setImmediate(() => process.emit('close', exitCode));
      return process as unknown as ReturnType<typeof spawn>;
    });
    return process;
  }
  it('always uses phantom exec with fixed argv, stdin payload and discarded diagnostics', async () => {
    const process = child(0); let payload = ''; process.stdin.on('data', chunk => { payload += String(chunk); });
    await sendViaPhantomExec(task(), root);
    expect(spawn).toHaveBeenLastCalledWith('phantom', ['exec', '--', expect.any(String), expect.stringMatching(/worker\.js$/)],
      expect.objectContaining({ cwd: root, stdio: ['pipe', 'ignore', 'ignore'], killSignal: 'SIGKILL' }));
    expect(JSON.parse(payload)).toEqual(task());
  });
  it('retains a failed delivery reservation and refuses a second send', async () => {
    child(1);
    const lane = new GrokbotLane({ stateRoot: root, secretsProject: root, caps, readBudget: async () => snapshot() });
    await expect(lane.submit(task())).rejects.toThrow('delivery-uncertain');
    await expect(lane.submit(task())).rejects.toThrow('duplicate-task');
  });
  it('refuses missing budget and reply path escapes before launching Secrets', async () => {
    vi.mocked(spawn).mockClear();
    const lane = new GrokbotLane({ stateRoot: root, secretsProject: root, caps, readBudget: async () => null });
    await expect(lane.submit(task())).rejects.toThrow('ledger-unavailable');
    await expect(lane.submit({ ...task(), reply_to: join(root, 'outside.json') })).rejects.toThrow('invalid-task');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('reads only matching bounded results and leaves approval advisory', async () => {
    child(0);
    const lane = new GrokbotLane({ stateRoot: root, secretsProject: root, caps, readBudget: async () => snapshot() });
    await expect(lane.submit(task())).resolves.toEqual({ id: 'task-1', status: 'accepted' });
    await expect(lane.readResult(task())).resolves.toBeNull();
    const result = { schema: 'grokbot-result.v1', id: 'task-1', status: 'needs-approval', summary: 'Mason must approve' };
    await writeFile(task().reply_to, JSON.stringify(result));
    await expect(lane.readResult(task())).resolves.toEqual(result);
    await writeFile(task().reply_to, JSON.stringify({ ...result, id: 'wrong-id' }));
    await expect(lane.readResult(task())).rejects.toThrow('invalid-result');
    await writeFile(task().reply_to, 'x'.repeat(16_385));
    await expect(lane.readResult(task())).rejects.toThrow('invalid-result');
    await rm(task().reply_to);
    await symlink(join(root, 'outside.json'), task().reply_to);
    await expect(lane.readResult(task())).rejects.toThrow('invalid-result');
  });
});
