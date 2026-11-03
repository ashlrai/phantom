import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_INBOX_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { ReassignError } from '../src/core/fleet/runs-reassign.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const ID = 'RQ-PHX-FAKEJOB01';
let root: string;
let runsDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desktop-interject-cmd-'));
  runsDir = join(root, 'runs');
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const stopJob = vi.fn();
const reassign = vi.fn();
async function post(text: string) {
  const handler = createFleetRunsApi({ runsDir, now: () => NOW, stopJob: stopJob as never, reassign: reassign as never });
  const req = Readable.from([JSON.stringify({ text })]) as unknown as IncomingMessage;
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': 'fake-local-operator' };
  req.method = 'POST';
  req.url = VERSE_FLEET_RUNS_INBOX_PATH;
  let status = 0;
  let raw = '';
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
    end(value: string) { raw = value; } } as unknown as ServerResponse;
  await handler({ token: 'fake-local-operator', allowDispatch: true } as VerseApiContext, req, res, VERSE_FLEET_RUNS_INBOX_PATH, 'POST');
  return { status, raw, body: JSON.parse(raw) as { command?: { status: string; reply: string } } };
}
const inbox = () => readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8');
const count = (text: string) => inbox().split(text).length - 1;

it('/stop runs stopJob once and replies in the same response', async () => {
  stopJob.mockResolvedValue({ outcome: 'stopped', pids: [11, 12] });
  const r = await post(`/stop ${ID}`);
  expect(stopJob).toHaveBeenCalledTimes(1);
  expect(stopJob.mock.calls[0]![0]).toBe(ID);
  expect(r.body.command).toEqual({ status: 'stopped', reply: `Stopped ${ID} (2 processes).` });
  expect(count(`/stop ${ID}`)).toBe(1);
});

it('/reassign passes lane, tier, apply, force and desktop attribution', async () => {
  reassign.mockResolvedValue({ applied: true, moved: [{ id: ID, toLane: 'devin', toTier: 'work' }] });
  const r = await post(`/reassign ${ID} devin work`);
  expect(reassign).toHaveBeenCalledTimes(1);
  expect(reassign.mock.calls[0]![0]).toMatchObject({ job: ID, lane: 'devin', tier: 'work', apply: true, force: false });
  expect(reassign.mock.calls[0]![1]).toMatchObject({ changedBy: 'desktop' });
  expect(r.body.command?.reply).toBe(`Moved ${ID} to devin/work.`);
  expect(count(`/reassign ${ID} devin work`)).toBe(1);
});

it('a ReassignError refusal yields the fixed refusal text', async () => {
  reassign.mockRejectedValue(new ReassignError('lane-held'));
  const r = await post(`/reassign ${ID} devin work`);
  expect(r.body.command?.reply).toBe('Reassign refused: lane is held.');
  expect(count(ID)).toBe(1);
});

it('never echoes a filesystem error from a throwing handler', async () => {
  stopJob.mockRejectedValue(new Error('EACCES /tmp/fake-secret-path'));
  const r = await post(`/stop ${ID}`);
  expect(r.body.command).toEqual({ status: 'failed', reply: 'Stop failed: job stop unavailable.' });
  expect(r.raw).not.toContain('/tmp/fake-secret-path');
  expect(count(ID)).toBe(1);
});

it('plain text has no command field and is appended as before', async () => {
  const r = await post('please look at the queue');
  expect(r.status).toBe(201);
  expect('command' in r.body).toBe(false);
  expect(stopJob).not.toHaveBeenCalled();
  expect(reassign).not.toHaveBeenCalled();
  expect(count('please look at the queue')).toBe(1);
});
