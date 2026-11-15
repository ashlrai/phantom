/**
 * Preservation of PR #4787 (RQ-PHX-DOTREPLYRECOVERY100): the Dot reply-age
 * read against the real API handler, a temporary teammate ledger, and the real
 * Leader-thread presentation model. Synthetic rowids, senders and text only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TeammateRow } from '../src/core/comms/imessage-teammate-inbox.js';
import {
  createCommsTeammateReplyAgeApi,
  teammateReplyAge,
  VERSE_COMMS_TEAMMATE_REPLY_AGE_PATH as PATH,
} from '../src/core/verse/comms-teammate-reply-age-api.js';
import { handleCommsTeammateReplyApi } from '../src/core/verse/comms-teammate-reply-api.js';
import { workbenchApiModules, type VerseApiContext } from '../src/core/verse/verse-api.js';
import { WORKBENCH_ROUTE_FAMILIES, workbenchFamilyFor } from '../src/core/verse/workbench-types.js';
import { dotReplyAge, type DotReplyAgeRead } from '../src/web-ui/routes/verse/leader-thread/DotReplyAge.model.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

let runsDir: string;
let ledger: string;
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'dot-reply-age-original-preserve-192s-'));
  mkdirSync(join(runsDir, 'imessage'), { recursive: true });
  ledger = join(runsDir, 'imessage', 'teammates.jsonl');
});
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

function writeLedger(rows: readonly TeammateRow[]): void {
  writeFileSync(ledger, rows.map(row => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
}

async function get(method = 'GET', allowDispatch = true) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: PATH, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const api = createCommsTeammateReplyAgeApi({ runsDir });
  const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, PATH, method);
  return { handled, status, text, body: text ? JSON.parse(text) as DotReplyAgeRead & Record<string, unknown> : null };
}

describe('dot reply age original preservation', () => {
  it('is mounted exactly once in the real workbench table', async () => {
    const families = WORKBENCH_ROUTE_FAMILIES.filter(family => family.id === 'comms-teammate-reply');
    expect(families).toHaveLength(1);
    expect(families[0]?.prefixes.filter(prefix => prefix === PATH)).toHaveLength(1);
    const mounts = workbenchApiModules().filter(module => module.id === 'comms-teammate-reply');
    expect(mounts).toHaveLength(1);
    expect(await mounts[0]?.load()).toBe(handleCommsTeammateReplyApi);
    expect(workbenchFamilyFor(PATH)?.id).toBe('comms-teammate-reply');
  });

  it('an older answered text plus a newer unanswered text reports the newer one unanswered, even when the older answer was written after the newer text arrived', async () => {
    writeLedger([
      { v: 1, at: iso(NOW - 40 * 60_000), rowid: 10, senderId: 'teammate-test-1', text: 'fake older text' },
      { v: 1, at: iso(NOW - 6 * 60_000), rowid: 11, senderId: 'teammate-test-1', text: 'fake newer text' },
      // A marker for the OLDER text, written after the newer text: a clock-only
      // comparison (outbound >= inbound) would wrongly call the newer text answered.
      { v: 1, answered: 10, at: iso(NOW - 2 * 60_000) },
    ]);
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      schema: 'comms.teammate-reply-age.v1', source: 'healthy',
      lastInboundAt: iso(NOW - 6 * 60_000), lastOutboundAt: null, answered: false,
    });
    expect(dotReplyAge(r.body, NOW)).toMatchObject({ bucket: 'ok', answered: false, ageMinutes: 6, text: 'Dot: last text 6 min ago, NOT answered' });
  });

  it('an older answered text plus a newer answered text reports the newer one answered with its own marker time', async () => {
    writeLedger([
      { v: 1, at: iso(NOW - 40 * 60_000), rowid: 10, senderId: 'teammate-test-1', text: 'fake older text' },
      { v: 1, answered: 10, at: iso(NOW - 35 * 60_000) },
      { v: 1, at: iso(NOW - 6 * 60_000), rowid: 11, senderId: 'teammate-test-1', text: 'fake newer text' },
      { v: 1, answered: 11, at: iso(NOW - 3 * 60_000) },
    ]);
    const r = await get();
    expect(r.body).toEqual({
      schema: 'comms.teammate-reply-age.v1', source: 'healthy',
      lastInboundAt: iso(NOW - 6 * 60_000), lastOutboundAt: iso(NOW - 3 * 60_000), answered: true,
    });
  });

  it('a missing ledger stays unknown: source missing, no times, no answer claim', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ schema: 'comms.teammate-reply-age.v1', source: 'missing', lastInboundAt: null, lastOutboundAt: null, answered: null });
    expect(dotReplyAge(r.body, NOW)).toMatchObject({ bucket: 'unknown', text: 'Dot: no iMessage record yet' });
  });

  it('keeps the access gate and the scrub: no dispatch is 404, POST is 405, bodies and sender ids never leave', async () => {
    writeLedger([
      { v: 1, at: iso(NOW - 4 * 60_000), rowid: 41, senderId: 'teammate-test-9', text: 'fake body that must not leak' },
    ]);
    expect((await get('GET', false)).status).toBe(404);
    expect((await get('POST')).status).toBe(405);
    const ok = await get();
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain('fake body that must not leak');
    expect(ok.text).not.toContain('teammate-test-9');
    expect(Object.keys(ok.body ?? {}).sort()).toEqual(['answered', 'lastInboundAt', 'lastOutboundAt', 'schema', 'source']);
  });

  it('the pure answer rule agrees with the route for an unanswered newest text behind an answered older marker', async () => {
    const rows: TeammateRow[] = [
      { v: 1, at: iso(NOW - 40 * 60_000), rowid: 10, senderId: 'teammate-test-1', text: 'fake' },
      { v: 1, answered: 10, at: iso(NOW - 1 * 60_000) },
      { v: 1, at: iso(NOW - 6 * 60_000), rowid: 11, senderId: 'teammate-test-1', text: 'fake' },
    ];
    writeLedger(rows);
    const r = await get();
    const pure = teammateReplyAge(rows);
    expect(pure).toEqual({ lastInboundAt: iso(NOW - 6 * 60_000), lastOutboundAt: null, answered: false });
    expect(r.body).toMatchObject(pure);
  });
});
