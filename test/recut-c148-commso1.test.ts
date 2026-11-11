import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendEmailOutbox } from '../src/core/comms/email-outbox.js';
import { validateAgentProfile } from '../src/core/agents/agent-profile.js';
import { listDrafts } from '../src/core/cos/drafts.js';

let dir: string;
let runs: string;
let outbox: string;
const sent: string[] = [];
const transport = async (m: { to: string }) => { sent.push(m.to); return { ok: true as const }; };
const put = (name: string, to: string) =>
  writeFileSync(join(outbox, name), `To: ${to}\nSubject: hello\n\nsynthetic body\n`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recut-c148-'));
  outbox = join(dir, 'outbox'); runs = join(dir, 'runs');
  mkdirSync(outbox, { recursive: true });
  sent.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = () => ({ dir: outbox, allowedRecipients: new Set(['self@example.com']), transport, draftsRunsDir: runs });

describe('recut c148: comms outbox policy wiring', () => {
  it('one pass sends to self, drafts an outside reply and refuses a denied one', async () => {
    const profile = validateAgentProfile({
      id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md', channels: ['email'],
      policy: { recipients: { allow: [], deny: ['blocked@example.com'] } },
    });
    put('a.reply.eml', 'self@example.com');
    put('b.reply.eml', 'outside@example.com');
    put('c.reply.eml', 'blocked@example.com');
    const r = await sendEmailOutbox({ ...base(), profile });
    expect(r.sent).toBe(1);
    expect(r.drafted).toBe(1);
    expect(r.refused).toBe(1);
    expect(sent).toEqual(['self@example.com']);
    const byName = new Map(r.details.map((d) => [d.name, d]));
    expect(byName.get('b.reply.eml')?.outcome).toBe('drafted');
    expect(byName.get('c.reply.eml')?.outcome).toBe('refused');
    expect(byName.get('c.reply.eml')?.reason).toBe('recipient-denied');
    // The refused envelope stays put for a later pass; it is never moved or sent.
    expect(existsSync(join(outbox, 'c.reply.eml'))).toBe(true);
    expect((await listDrafts({ runsDir: runs })).map((d) => d.to)).toEqual(['outside@example.com']);
    expect(readdirSync(join(outbox, 'sent'))).toEqual(['a.reply.eml']);
  });

  it('a second pass re-evaluates a refused envelope instead of losing it', async () => {
    const denying = validateAgentProfile({
      id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md', channels: ['email'],
      policy: { recipients: { allow: [], deny: ['blocked@example.com'] } },
    });
    put('a.reply.eml', 'blocked@example.com');
    const first = await sendEmailOutbox({ ...base(), profile: denying });
    expect(first.refused).toBe(1);
    // Same envelope, policy now permits the draft stage: it drafts rather than sending.
    const drafting = validateAgentProfile({ id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md', channels: ['email'] });
    const second = await sendEmailOutbox({ ...base(), profile: drafting });
    expect(second.refused).toBe(0);
    expect(second.drafted).toBe(1);
    expect(sent).toEqual([]);
    expect((await listDrafts({ runsDir: runs })).map((d) => d.to)).toEqual(['blocked@example.com']);
  });
});
