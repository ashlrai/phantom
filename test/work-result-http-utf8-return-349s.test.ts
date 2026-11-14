/** RQ-PHX-RESULTUTF8RETURN349S — POST /api/verse/fleet/work-board/result with
 * the JSON body delivered as Buffer chunks that split INSIDE multibyte code
 * points. Real reader (readBody from ../web/api.js via fleet-work-board-api),
 * real default postReply and real temp bus store; nothing decoded or stored
 * is mocked. A fresh API instance reads the board back, and a differently
 * chunked replay must be 'duplicate'. Fake ids and evidence only. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VERSE_FLEET_WORK_BOARD_PATH as BOARD,
  VERSE_FLEET_WORK_RESULT_PATH as RESULT,
  createFleetWorkBoardApi,
} from '../src/core/verse/fleet-work-board-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { appendBusInbox, listBusInboxAfter, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';

const ID = 'RQ-PHX-FAKE-349-A';
const TS = 'T0FAKEDT/C0FAKEDT/1700000000.000349a';
const TESTS_EVIDENCE = '✓ 3 passed';
const ARTIFACT_EVIDENCE = 'out/résumé-✓.txt';

const slackRequest = (): BusEnvelope => ({
  id: ID, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: 10_000_000,
  channel: 'slack', channel_ref: TS, external: false, body: { kind: 'work' },
  sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
});

/** Bytewise: every byte is its own chunk, so every code point is split. */
const bytewise = (bytes: Buffer): Buffer[] => Array.from(bytes, (_, i) => bytes.subarray(i, i + 1));
/** Cut once right after each multibyte lead byte (and nowhere else). */
function afterLeadBytes(bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let from = 0;
  bytes.forEach((b, i) => { if (b >= 0xc0) { out.push(bytes.subarray(from, i + 1)); from = i + 1; } });
  out.push(bytes.subarray(from));
  return out;
}
/** True when some cut falls strictly inside a multibyte sequence (continuation byte follows). */
const splitsCodePoint = (parts: Buffer[]) =>
  parts.slice(1).some(p => (p[0]! & 0xc0) === 0x80);

async function call(api: ApiModule, method: string, path: string, parts?: Buffer[]) {
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const req = Object.assign(new EventEmitter(), { url: path }) as unknown as IncomingMessage;
  const pending = api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, path.split('?')[0]!, method);
  if (parts) {
    await Promise.resolve();
    for (const p of parts) req.emit('data', p);
    req.emit('end');
  }
  await pending;
  return { status, body: text ? JSON.parse(text) : null };
}

const json = (replyId: string, result: Record<string, string>) =>
  Buffer.from(JSON.stringify({ requestId: ID, replyId, result }), 'utf8');
const inboxIds = (root: string) => {
  const page = listBusInboxAfter(0, 100, { root });
  return page.status === 'ok' ? page.messages.map(m => m.envelope.id) : [];
};
const replyBody = (root: string, id: string) => {
  const page = listBusInboxAfter(0, 100, { root });
  return page.status === 'ok' ? page.messages.find(m => m.envelope.id === id)?.envelope.body : undefined;
};
const boardResult = async (api: ApiModule) => {
  const r = await call(api, 'GET', BOARD);
  expect(r.status).toBe(200);
  return (r.body.items as { id: string; result?: unknown }[]).find(i => i.id === ID)?.result;
};

describe('work-board result http utf8 chunk boundaries', { timeout: 60_000 }, () => {
  let home: string, fleetRoot: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'result-http-utf8-349-'));
    fleetRoot = join(home, 'fleet');
    vi.stubEnv('ASHLR_HOME', home);
    expect(appendBusInbox(slackRequest()).status).toBe('posted');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const cases = [
    ['tests', 'fake-reply-349-tests', { tests: TESTS_EVIDENCE }, 'tests'],
    ['artifact', 'fake-reply-349-artifact', { artifact: ARTIFACT_EVIDENCE }, 'artifact'],
  ] as const;

  for (const [name, replyId, result, key] of cases) {
    it(`${name}: evidence survives mid-code-point splits and a re-chunked replay is a duplicate`, async () => {
      const evidence = result[key as keyof typeof result] as string;
      const bytes = json(replyId, result);
      expect(bytes.length).toBeGreaterThan(evidence.length); // multibyte: bytes > UTF-16 units
      // Control: the same bytes in one chunk establish what a clean body does.
      const oneChunk = [bytes];
      // bytewise splits every code point; the replay cuts only after each lead byte.
      const bytewiseParts = bytewise(bytes);
      const fives = afterLeadBytes(bytes);
      expect(splitsCodePoint(bytewiseParts)).toBe(true);
      expect(splitsCodePoint(fives)).toBe(true);

      // Control first, in a throwaway store, so corruption vs validation is distinguishable.
      const controlHome = mkdtempSync(join(tmpdir(), 'result-http-utf8-349-ctl-'));
      let controlStored: unknown;
      try {
        vi.stubEnv('ASHLR_HOME', controlHome);
        expect(appendBusInbox(slackRequest()).status).toBe('posted');
        const ctl = await call(createFleetWorkBoardApi(), 'POST', RESULT, oneChunk);
        expect(ctl.status).toBe(200);
        expect(ctl.body.outcome).toBe('posted');
        controlStored = replyBody(join(controlHome, 'fleet'), replyId);
      } finally {
        vi.stubEnv('ASHLR_HOME', home);
        rmSync(controlHome, { recursive: true, force: true });
      }
      expect(JSON.stringify(controlStored)).toContain(evidence);

      const posted = await call(createFleetWorkBoardApi(), 'POST', RESULT, bytewiseParts);
      expect(posted.status).toBe(200);
      expect(posted.body).toMatchObject({ outcome: 'posted', schema: 'fleet.bus-reply.v1' });
      expect(inboxIds(fleetRoot)).toEqual([ID, replyId]);
      expect(replyBody(fleetRoot, replyId)).toEqual(controlStored);
      expect(JSON.stringify(replyBody(fleetRoot, replyId))).toContain(evidence);
      expect(JSON.stringify(replyBody(fleetRoot, replyId))).not.toContain('�');

      // Fresh API instance: board shows the exact evidence.
      const fresh = createFleetWorkBoardApi();
      const result2 = await boardResult(fresh) as Record<string, unknown>;
      expect(result2).toMatchObject({ kind: 'verified' });
      expect(Object.values(result2)).toContain(evidence);

      // Replay through a different chunking: duplicate, durable store untouched.
      const snapshotFile = join(fleetRoot, 'bus-inbox', 'messages.json');
      const snapshot = readFileSync(snapshotFile, 'utf8');
      const replay = await call(createFleetWorkBoardApi(), 'POST', RESULT, fives);
      expect(replay.status).toBe(200);
      expect(replay.body.outcome).toBe('duplicate');
      expect(inboxIds(fleetRoot)).toEqual([ID, replyId]);
      expect(readFileSync(snapshotFile, 'utf8')).toBe(snapshot);
      expect(await boardResult(createFleetWorkBoardApi())).toEqual(result2);
    });
  }
});
