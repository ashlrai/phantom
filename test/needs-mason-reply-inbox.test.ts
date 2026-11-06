import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { listNeedsMason, resolveNeedsMason, type NeedsMasonOptions } from '../src/core/fleet/needs-mason-resolve.js';
import { resolveNeedsMasonWithInbox } from '../src/core/fleet/needs-mason-relay.js';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let root: string;
let options: NeedsMasonOptions;
let itemId: string;
const now = () => 1_800_000_000_000;
const inboxPath = () => join(root, 'leader', 'MASON-INBOX.md');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fake-reply-inbox-'));
  writeFileSync(join(root, 'NEEDS-MASON.md'), '# Needs Mason\n- [ ] Pick a fake color\n');
  options = { runsDir: root, bus: { root: join(root, 'fake-bus'), now }, now };
  itemId = listNeedsMason(options)[0]!.id;
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it('appends one desktop channel-line with the item and trimmed reply', async () => {
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  expect(await resolveNeedsMasonWithInbox({ itemId, reply: '  Use fake blue  ' }, { ...options, runsDir: undefined }))
    .toMatchObject({ ok: true, inbox: 'appended' });
  const text = readFileSync(inboxPath(), 'utf8');
  expect(text).toContain('[src:desktop id:desk-');
  expect(parseInbox(text)).toMatchObject([{ text: `Re needs-you ${itemId} ("Pick a fake color"): Use fake blue` }]);
});

it.each([undefined, '   '])('skips an absent or blank reply (%s)', async reply => {
  expect(await resolveNeedsMasonWithInbox({ itemId, reply }, options)).toMatchObject({ ok: true, inbox: 'skipped' });
  expect(existsSync(inboxPath())).toBe(false);
});

it('refuses a second resolve without appending another entry', async () => {
  await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, options);
  expect(await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake green' }, options))
    .toMatchObject({ ok: false, code: 'already-resolved', inbox: 'skipped' });
  expect(parseInbox(readFileSync(inboxPath(), 'utf8'))).toHaveLength(1);
});

it('skips a duplicate bus resolution', async () => {
  expect(resolveNeedsMason({ itemId, reply: 'Use fake blue' }, options)).toMatchObject({ ok: true });
  // Simulate retrying after the bus accepted the event but the marker was lost.
  writeFileSync(join(root, 'NEEDS-MASON.md'), '- [ ] Pick a fake color\n');
  expect(await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, options))
    .toMatchObject({ ok: true, duplicate: true, inbox: 'skipped' });
  expect(existsSync(inboxPath())).toBe(false);
});

it.each(['throws', 'refuses'])('preserves successful resolution when append %s', async mode => {
  const appendInbox = vi.fn(async () => {
    if (mode === 'throws') throw new Error('fake write failure');
    return { ok: false as const, reason: 'write-failed' as const };
  });
  expect(await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, { ...options, appendInbox }))
    .toMatchObject({ ok: true, inbox: 'failed' });
  expect(appendInbox).toHaveBeenCalledOnce();
  expect(listNeedsMason(options)).toEqual([]);
});

it('returns inbox status through the route with an injected async resolver', async () => {
  const handler = createAgentBusApi({ needsMason: {
    list: () => listNeedsMason(options), resolve: async input => resolveNeedsMasonWithInbox(input, options),
  } });
  const path = '/api/verse/agent-bus/needs-mason/resolve';
  const req = Readable.from([JSON.stringify({ itemId, reply: 'Use fake blue' })]) as unknown as IncomingMessage;
  req.url = path; req.method = 'POST';
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': 'fake-mutation-token' };
  let status = 0, wire: unknown;
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { wire = JSON.parse(text); } } as unknown as ServerResponse;
  const ctx = { cfg: {}, token: 'fake-mutation-token', allowDispatch: true } as VerseApiContext;
  await handler(ctx, req, res, path, 'POST');
  expect(status).toBe(200);
  expect(wire).toMatchObject({ status: 'resolved', itemId, inbox: 'appended' });
});
