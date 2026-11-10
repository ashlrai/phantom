// The two-way Leader thread round trip, end to end on the server side and with
// no mocks on the file paths:
//   1. The desktop "Steer the fleet → tell the Leader" box posts to
//      /api/verse/fleet/runs/inbox (the same path and body builder the console
//      uses); exactly one "[src:desktop id:…]" line lands in MASON-INBOX.md,
//      and posting the same request again adds no second line — even through a
//      fresh API instance, because the channel receipt store is durable.
//   2. A Leader reply appended to MASON-OUTBOX.md in the real writer's
//      "## <ISO> [leader-network:reply-…]\nLeader: …" format is projected by
//      the same GET /api/verse/fleet/runs read that feeds the desktop
//      LeaderThreadPane merge (mergeThread) and the phone /verse/m rows
//      (leaderReplyRows over narrowInboxTail + fleetOutbox): both surfaces see
//      the reply sitting under the words it answered.
// Attribution is [src:desktop] because the Hub stamps the authenticated
// console channel — the body's `source` stays display metadata and a client
// cannot pick its own channel.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFleetRunsApi, type FleetRunsApiDeps } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { INTERJECT_POST_PATH, buildInterjectBody } from '../src/web-ui/routes/verse/fleet/interject-request.js';
import { fleetInbox, fleetOutbox, mergeThread } from '../src/web-ui/routes/verse/leader-thread/thread-merge-model.js';
import { narrowInboxTail } from '../src/web-ui/routes/verse/mobile/inbox-tail-query.js';
import { leaderReplyRows } from '../src/web-ui/routes/verse/mobile/leader-replies-model.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const TEXT = 'Fake steer: hold the codex lane until the fixture lands';
const REPLY = 'Fake reply: the codex lane is parked for you.';
const REPLY_AT = new Date(NOW + 2 * 60_000).toISOString();

let root: string;
let runsDir: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  root = mkdtempSync(join(tmpdir(), 'leader-interject-roundtrip-'));
  runsDir = join(root, 'runs');
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** Real inbox/outbox readers and the real channel receiver; stub only the
 * composite's unrelated sources (gh, the process table, ~/.codex-2) so the GET
 * stays hermetic and fast. The owner-thread mirror gets temp roots so it can
 * never touch the account's fixed owner dirs. */
function deps(): FleetRunsApiDeps {
  return {
    runsDir,
    now: () => NOW,
    readRunsDir: async () => ({
      lastTick: null, paused: null, memFreePct: null, diskFreeGb: null,
      switches: [], claudeLane: null, lanes: [], publishesLastHour: [], events: [],
    }),
    listWorkers: async () => ({ workers: [], leaders: [], orchestratorAgents: null }),
    readHostLoad: () => ({ load1: 0, load5: 0, load15: 0, cores: 1, ratio: 0 }),
    codexPersonal: async () => null,
    mergedLastHour: async () => ({ count: 0, perHour: null, medianOpenToMergeMs: null, items: [] }),
    ownerThread: { runsDir: join(root, 'owner-runs'), configDir: join(root, 'owner-config') },
  };
}

async function call(handler: ReturnType<typeof createFleetRunsApi>, url: string, method: 'GET' | 'POST', body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': 'fake-token' };
  req.method = method;
  req.url = url;
  let status = 0;
  let out = '';
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; }, end(value: string) { out = value; } } as unknown as ServerResponse;
  await handler({ token: 'fake-token', allowDispatch: true } as VerseApiContext, req, res, url.split('?')[0]!, method);
  return { status, body: JSON.parse(out) as Record<string, unknown> };
}

const inboxLines = () => readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8').split('\n').filter(line => /\[src:/.test(line));

it('the steer box lands once in MASON-INBOX.md with a source tag, and a repost dedupes', async () => {
  const handler = createFleetRunsApi(deps());
  const posted = await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody(TEXT));
  expect(posted).toMatchObject({ status: 201, body: { ok: true, accepted: true } });
  const id = posted.body.id as string;
  expect(typeof id).toBe('string');
  expect(String(posted.body.dedupeKey)).toMatch(/^sha256:[0-9a-f]+$/);

  const lines = inboxLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(new RegExp(`^\\S+ \\[src:desktop id:${id}\\] ${TEXT}$`));

  // The same request again is acknowledged as a duplicate, not appended.
  const again = await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody(TEXT));
  expect(again).toMatchObject({ status: 200, body: { ok: true, duplicate: true, accepted: false } });
  expect(inboxLines()).toHaveLength(1);

  // And still deduped after a Hub restart — the receipt store is durable.
  const restarted = createFleetRunsApi(deps());
  const repost = await call(restarted, INTERJECT_POST_PATH, 'POST', buildInterjectBody(TEXT));
  expect(repost).toMatchObject({ status: 200, body: { ok: true, duplicate: true, accepted: false } });
  expect(inboxLines()).toHaveLength(1);
});

it('a Leader reply in MASON-OUTBOX.md reads back through the same fleet runs read both surfaces use', async () => {
  const handler = createFleetRunsApi(deps());
  const posted = await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody(TEXT));
  expect(posted).toMatchObject({ status: 201, body: { ok: true, accepted: true } });

  // The leader-network writer's exact reply record: "## <ISO> [leader-network:reply-<64hex>]"
  // then "Leader: <text>".
  appendFileSync(
    join(runsDir, 'leader', 'MASON-OUTBOX.md'),
    `\n## ${REPLY_AT} [leader-network:reply-${'f'.repeat(64)}]\nLeader: ${REPLY}\n`,
  );

  const read = await call(handler, VERSE_FLEET_RUNS_PATH, 'GET');
  expect(read.status).toBe(200);
  const data = read.body;
  expect(fleetInbox(data).some(entry => entry.text === TEXT)).toBe(true);
  expect(fleetOutbox(data).some(entry => entry.at === REPLY_AT && entry.text === `Leader: ${REPLY}`)).toBe(true);

  // Desktop: LeaderThreadPane's merge over the same inbox + outbox projections.
  const merged = mergeThread([], fleetInbox(data), NOW + 5 * 60_000, data, fleetOutbox(data));
  const masonIndex = merged.lines.findIndex(line => line.who === 'mason' && line.text === TEXT);
  const replyIndex = merged.lines.findIndex(line => line.who === 'leader' && line.text.includes(REPLY));
  expect(masonIndex).toBeGreaterThanOrEqual(0);
  expect(replyIndex).toBeGreaterThan(masonIndex);

  // Phone: /verse/m's LeaderReplies over the same read — same ordering, and the
  // reply keeps its link to the Mason line it answered.
  const rows = leaderReplyRows(fleetOutbox(data), narrowInboxTail(data), NOW + 5 * 60_000);
  const replyRow = rows.find(row => row.who === 'leader' && row.text.includes(REPLY));
  expect(rows.some(row => row.who === 'mason' && row.text === TEXT)).toBe(true);
  expect(replyRow?.answers).toBe(TEXT);
});
