import { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { handleLeaderApi, setLeaderApiHooksForTest } from '../src/core/verse/leader-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

it('previews rejected Claude under limited and chooses the working login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'planner-plan-auth-'));
  try {
    await mkdir(join(root, 'queue'));
    await mkdir(join(root, 'supervisor'));
    await writeFile(join(root, 'queue/planner-candidates.json'), JSON.stringify({
      v: 1, lastProvider: 'claude', candidates: [
        { provider: 'claude', argv: ['echo'] }, { provider: 'codex-personal', argv: ['echo'] },
      ],
    }));
    await writeFile(join(root, 'queue/dispatch-events.log'), '2026-11-01 11:50:00 LEADER claude rc=1\n');
    await writeFile(join(root, 'supervisor/run.fixture.log'), 'authentication_error');
    setLeaderApiHooksForTest({ plannerRunsRoot: () => root, now: () => new Date(2026, 10, 1, 12).getTime() });
    const path = '/api/verse/leader/planner/plan';
    const req = Object.assign(Readable.from([]), { url: path, method: 'GET', headers: {} }) as unknown as IncomingMessage;
    let status = 0;
    let body: unknown;
    const res = {
      writeHead(code: number) { status = code; }, setHeader() {},
      end(text: string) { body = JSON.parse(text); },
    } as unknown as ServerResponse;
    expect(await handleLeaderApi({} as VerseApiContext, req, res, path, 'GET')).toBe(true);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      source: 'ok', choice: { provider: 'codex-personal' },
      limited: [{ provider: 'claude', status: 'auth-rejected', until: null }],
      health: [{ provider: 'claude', status: 'failing', reason: 'auth-rejected', resetAt: null }],
    });
  } finally {
    setLeaderApiHooksForTest({});
    await rm(root, { recursive: true, force: true });
  }
});
