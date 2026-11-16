import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';

it('reports unreadable persisted tasks and recovers without changing them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'teamtasks-disk-'));
  const previous = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = root;
  const dir = join(root, 'imessage');
  const file = join(dir, 'teammate-tasks.json');
  const path = '/api/verse/fleet/control/teammate-tasks';
  const call = async () => {
    send.mockClear();
    const before = Date.now();
    expect(await handleFleetControlApi({} as VerseApiContext, { url: path } as IncomingMessage,
      {} as ServerResponse, path, 'GET')).toBe(true);
    return { status: send.mock.lastCall?.[1], body: send.mock.lastCall?.[2], before, after: Date.now() };
  };
  try {
    const first = await call();
    expect(first.status).toBe(200);
    expect(first.body.rows).toEqual([]);
    mkdirSync(dir, { mode: 0o700 });
    for (const invalid of ['{private diagnostic', JSON.stringify({ v: 1, tasks: [{}], attempts: { dot: [], instinct: [] } })]) {
      writeFileSync(file, invalid, { mode: 0o600 });
      const response = await call();
      expect([response.status, response.body]).toEqual([503, { error: 'teammate tasks unavailable' }]);
      expect(readFileSync(file, 'utf8')).toBe(invalid);
    }
    rmSync(file);
    mkdirSync(file);
    const unavailable = await call();
    expect([unavailable.status, unavailable.body]).toEqual([503, { error: 'teammate tasks unavailable' }]);
    rmSync(file, { recursive: true });
    const stored = JSON.stringify({ v: 1, attempts: { dot: [], instinct: [] }, tasks: [{
      jobId: 'RQ-FAKE-1', peer: 'dot', kind: 'report', scope: 'fake scope', repo: 'example/repo',
      prRefs: [1], format: 'fake format', deadline: '2030-01-01T00:00:00.000Z',
      token: 'a'.repeat(32), createdAt: 1700000000000, state: 'replied', attemptedAt: 1700000000001,
      receipt: { rowid: 1, sent: true, delivered: true, error: 0 },
      result: { rowid: 2, status: 'DONE', summary: 'private fake summary', at: 1700000000002 },
      metrics: ['launch'], settled: false,
    }] });
    writeFileSync(file, stored, { mode: 0o600 });
    const recovered = await call();
    expect(recovered.status).toBe(200);
    expect(Date.parse(recovered.body.asOf)).toBeGreaterThanOrEqual(recovered.before);
    expect(Date.parse(recovered.body.asOf)).toBeLessThanOrEqual(recovered.after);
    expect(recovered.body.counts.replied).toBe(1);
    expect(recovered.body.rows).toHaveLength(1);
    expect(recovered.body.rows[0].workState).toBe('REPORTED_DONE');
    const output = JSON.stringify(recovered.body);
    for (const value of ['token', 'claimKey', 'resource', 'receipt', 'summary', 'private fake summary', 'a'.repeat(32)]) {
      expect(output).not.toContain(value);
    }
    expect(readFileSync(file, 'utf8')).toBe(stored);
  } finally {
    if (previous === undefined) delete process.env['ASHLR_RUNS_DIR'];
    else process.env['ASHLR_RUNS_DIR'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
