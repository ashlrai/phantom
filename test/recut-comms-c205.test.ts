import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendEmailOutbox } from '../src/core/comms/email-outbox.js';
import { listDrafts } from '../src/core/cos/drafts.js';

// RQ-PHX-RECUTCOMMSC205: regression for the recut outside-send policy gate.
// A reply to a non-allowlisted recipient must be held as a draft through the
// fail-closed default profile, never sent to the transport.
let dir: string;
let outbox: string;
let runs: string;
const sent: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recut-comms-c205-'));
  outbox = join(dir, 'outbox');
  runs = join(dir, 'runs');
  mkdirSync(outbox, { recursive: true });
  sent.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('email outbox outside-send gate (recut c205)', () => {
  it('drafts a non-allowlisted reply instead of sending it', async () => {
    writeFileSync(join(outbox, 'a.reply.eml'), 'To: outside@example.test\nSubject: hi\n\nsynthetic body\n');
    const transport = async (m: { to: string }) => { sent.push(m.to); return { ok: true as const }; };
    const result = await sendEmailOutbox({
      dir: outbox,
      allowedRecipients: new Set(['self@example.test']),
      transport,
      draftsRunsDir: runs,
    });
    expect(result.sent).toBe(0);
    expect(result.drafted).toBe(1);
    expect(result.refused).toBe(0);
    expect(sent).toEqual([]);
    expect((await listDrafts({ runsDir: runs })).map((d) => d.to)).toEqual(['outside@example.test']);
  });
});
