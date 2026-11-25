import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readImessageAckEvidence } from '../src/core/comms/imessage-ack-evidence.js';
import { defaultChannelSources, readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-25T18:00:00.000Z');
const old = '2026-11-01T00:00:00.000Z';
const recent = '2026-11-25T17:30:00.000Z';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const row = (at = old, rowid = 952001, status = 'accepted') => JSON.stringify({
  at, rowid, status, text: 'FAKE_PRIVATE_BODY', extra: 'FAKE_SOURCE_CONTENT',
}) + '\n';
function journal(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'imessage-952s-'));
  roots.push(root);
  mkdirSync(join(root, 'imessage'), { mode: 0o700 });
  writeFileSync(join(root, 'imessage', 'acks.jsonl'), body, { mode: 0o600 });
  return root;
}
const other: ChannelSource = { configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [] };
async function health(root: string) {
  const imessage = { ...defaultChannelSources(root).imessage, configMissing: () => [], processAlive: () => true };
  return (await readChannelHealth({ now: () => now, host: 'fake-host', sources: { slack: other, imessage } })).channels[1]!;
}

it('marks a complete byte-truncated journal and prevents idle LIVE through the real source', async () => {
  const body = row().repeat(3000);
  expect(Buffer.byteLength(body)).toBeGreaterThan(256 * 1024);
  const root = journal(body);
  const evidence = await readImessageAckEvidence(4096, root);
  expect(evidence).toMatchObject({ sourceState: 'ok', malformedRows: 0, deliveryProof: false, projectionOmitted: true });
  expect(evidence.rows.length).toBeGreaterThan(0);
  const result = await health(root);
  expect(result).toMatchObject({ state: 'UNKNOWN', unansweredCount: 0,
    proof: { requestCoverage: 'unproven' }, missing: ['imessage inbound journal projection incomplete'] });
  expect(JSON.stringify(result)).not.toMatch(/952001|FAKE_PRIVATE_BODY|FAKE_SOURCE_CONTENT|rowid|text/);
});

it('marks matching-row omission after selection without changing accepted/duplicate semantics', async () => {
  const root = journal(row(old, 1) + row(old, 2) + row(old, 1, 'duplicate'));
  expect(await readImessageAckEvidence(1, root, 1)).toMatchObject({ projectionOmitted: true, match: 'matched',
    malformedRows: 0, deliveryProof: false, rows: [{ rowid: 1, status: 'duplicate', delivery: 'unknown' }] });
  const complete = await readImessageAckEvidence(2, root, 1);
  expect(complete.projectionOmitted).toBeUndefined();
  expect(complete.rows.map((r) => r.status)).toEqual(['accepted', 'duplicate']);
  expect((await readImessageAckEvidence(1, root, 2)).projectionOmitted).toBeUndefined();
  expect(await readImessageAckEvidence(1, root, 3)).toMatchObject({ match: 'no-match', rows: [] });
});

it('preserves complete empty/small journals and ignores duplicate inbound activity', async () => {
  for (const body of ['', row(), row(recent, 1, 'duplicate')]) {
    const root = journal(body);
    expect((await readImessageAckEvidence(4096, root)).projectionOmitted).toBeUndefined();
    expect(await health(root)).toMatchObject({ state: 'LIVE', unansweredCount: 0,
      proof: { requestCoverage: 'idle' }, missing: [] });
  }
});

it('keeps visible overdue accepted evidence DEGRADED despite omitted coverage', async () => {
  const root = journal(row().repeat(3000) + row(recent));
  expect(await health(root)).toMatchObject({ state: 'DEGRADED', unansweredCount: 1,
    proof: { requestCoverage: 'unproven' }, missing: ['imessage inbound journal projection incomplete'] });
});

it('preserves positive send failure precedence with incomplete coverage', async () => {
  const root = journal(row().repeat(3000));
  writeFileSync(join(root, 'imessage', 'last-send.json'), JSON.stringify({ ok: false, at: recent }), { mode: 0o600 });
  expect(await health(root)).toMatchObject({ state: 'DEGRADED', proof: { requestCoverage: 'unproven' },
    missing: ['imessage inbound journal projection incomplete', 'imessage outbound send failed'] });
});
