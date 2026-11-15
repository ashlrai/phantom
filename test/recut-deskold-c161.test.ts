import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createOwnerThreadApi, VERSE_OWNER_THREAD_PATH } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

/**
 * Recut check for PR #4553 (RQ-PHX-LEADERSTATUSNOW52): the Leader pane's
 * "Status now" serves the instant brief with line breaks preserved and never
 * posts it onto the owner thread. Asserted against master's module.
 */
async function call(api: ReturnType<typeof createOwnerThreadApi>, path: string) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: path, method: 'GET' }) as IncomingMessage;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, path, 'GET');
  return { handled, status, body: JSON.parse(text) };
}

describe('leader status now (recut of #4553)', () => {
  it('returns the brief with line breaks intact and does not add it to the thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recut-c161-'));
    try {
      const statusBrief = vi.fn(async () => 'Queue is clear\nCI is green on main');
      const api = createOwnerThreadApi({ runsDir: dir, configDir: dir, statusBrief, now: () => 0 });
      const status = await call(api, `${VERSE_OWNER_THREAD_PATH}/status`);
      expect(status.handled).toBe(true);
      expect(status.status).toBe(200);
      expect(status.body.schema).toBe('comms.owner-status.v1');
      expect(status.body.text).toBe('Queue is clear\nCI is green on main');
      const thread = await call(api, VERSE_OWNER_THREAD_PATH);
      expect(thread.body.messages).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
