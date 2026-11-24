import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';
import { createFleetCoordinationMutateApi, VERSE_FLEET_COORDINATION_RETURN_PATH as route } from '../src/core/verse/fleet-coordination-mutate-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

// Each child loads a fresh handler and ledger implementation. IPC releases all
// callers together; no network, shared module state, or timing sleeps are used.
const childScript = `
import { EventEmitter } from 'node:events';
import { createFleetCoordinationMutateApi, VERSE_FLEET_COORDINATION_RETURN_PATH as route } from './src/core/verse/fleet-coordination-mutate-api.ts';
import { returnFleetClaim } from './src/core/fleet/coordination-return.ts';
process.send({ ready: true });
process.once('message', async ({ path, body }) => {
  const api = createFleetCoordinationMutateApi({ now: () => new Date(2000),
    return: (input, now) => returnFleetClaim(input, { path, now }) });
  let status = 0, text = '';
  const res = { writeHead(code) { status = code; return this; }, end(value) { text = value; } };
  const req = Object.assign(new EventEmitter(), { url: route });
  const pending = api({}, req, res, route, 'POST');
  await Promise.resolve();
  req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end');
  await pending;
  process.send({ status, body: JSON.parse(text) }, () => process.disconnect());
});`;

async function firstReturn(path: string, body: object) {
  const api = createFleetCoordinationMutateApi({ now: () => new Date(2000),
    return: (input, now) => returnFleetClaim(input, { path, now }) });
  let status = 0;
  const res = { writeHead(code: number) { status = code; return this; }, end() {} } as unknown as ServerResponse;
  const req = Object.assign(new EventEmitter(), { url: route }) as unknown as IncomingMessage;
  const pending = api({} as VerseApiContext, req, res, route, 'POST');
  await Promise.resolve();
  req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end');
  expect(await pending).toBe(true);
  expect(status).toBe(200); // The response body is intentionally discarded.
}

it('replays a lost HTTP response across overlapping independent callers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'return-race-553s-'));
  const path = join(dir, 'ledger.jsonl');
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const claim = claimFleetWork({ repo: 'fixture/project', task: 'qualify return', agent: 'host-a' }, { path, now: 1000 });
    if (!claim.ok) throw new Error(`claim failed: ${claim.error}`);
    const { lease, claim: { id } } = claim.value;
    const original = { claimId: id, agent: 'host-a', lease, result: { pr: 553, head: 'abcdef1234567' } };
    await firstReturn(path, original);
    const bodies = [original, { ...original, result: { tests: 'competing label' } },
      { ...original, agent: 'host-b', lease: 'plainly-fake-lease', result: { tests: 'spoofed' } }];
    const pending = bodies.map(body => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      let release!: () => void;
      const ready = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => { if (code !== 0) reject(new Error(`child exited ${code}`)); });
        child.once('message', () => { release = () => child.send({ path, body }); resolve(); });
      });
      const result = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        child.on('message', message => { if (typeof message === 'object' && message !== null && 'status' in message) resolve(message as { status: number; body: Record<string, unknown> }); });
        child.once('error', reject);
        child.once('exit', code => { if (code !== 0) reject(new Error(`child exited ${code}`)); });
      });
      return { ready, result, start: () => release() };
    });
    await Promise.all(pending.map(p => p.ready));
    pending.forEach(p => p.start());
    const responses = await Promise.all(pending.map(p => p.result));
    for (const response of responses.slice(0, 2)) {
      expect(response).toMatchObject({ status: 200, body: { ok: true, outcome: 'already-returned', claimId: id,
        message: { id: `return-${id}`, from: 'host-a', body: `RESULT VERIFIED fixture/project claim ${id} task "qualify return": pr #553 head abcdef1234567` } } });
      expect(JSON.stringify(response)).not.toContain(lease);
    }
    expect(responses[2]).toMatchObject({ body: { ok: false, outcome: 'not-owner', claimId: id } });
    const raw = readFileSync(path, 'utf8');
    const events = raw.trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.kind)).toEqual(['claim', 'return', 'post']);
    expect(events[1]).toMatchObject({ id, agent: 'host-a', message: { from: 'host-a', body: expect.stringContaining('pr #553 head abcdef1234567') } });
    expect(raw).not.toContain(lease);
    const board = readFleetBoard({ path, now: 3000 });
    expect(board).toMatchObject({ state: 'known', claims: [] });
    expect(board.messages).toHaveLength(1);
    const view = projectCoordinationReturns(board, 3000);
    expect(view).toMatchObject({ state: 'known', unparsed: 0, returns: [{ claimId: id, repo: 'fixture/project', from: 'host-a', pr: 553, head: 'abcdef1234567', evidenceKind: 'pr' }] });
    expect(JSON.stringify(view)).not.toMatch(/lease/i);
    expect(board.messages[0]?.body).toContain('task "qualify return"');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
