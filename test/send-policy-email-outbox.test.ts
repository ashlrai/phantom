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
  dir = mkdtempSync(join(tmpdir(), 'send-policy-outbox-'));
  outbox = join(dir, 'outbox'); runs = join(dir, 'runs');
  mkdirSync(outbox, { recursive: true });
  sent.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = () => ({ dir: outbox, allowedRecipients: new Set(['self@example.com']), transport, draftsRunsDir: runs });

describe('email outbox send policy', () => {
  it('keeps outside sends as drafts while limitsTodo is true', async () => {
    put('a.reply.eml', 'outside@example.com');
    const r = await sendEmailOutbox(base());
    expect(r.drafted).toBe(1);
    expect(r.sent).toBe(0);
    expect(sent).toEqual([]);
    expect((await listDrafts({ runsDir: runs })).map((d) => d.to)).toEqual(['outside@example.com']);
  });

  it('still drafts when a profile claims allowlist-auto with limits done', async () => {
    const profile = validateAgentProfile({
      id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md', channels: ['email'],
      policy: { send: 'allowlist-auto', perMessageApproval: false, recipients: { allow: ['outside@example.com'], deny: [] }, limitsTodo: false },
    });
    put('a.reply.eml', 'outside@example.com');
    const r = await sendEmailOutbox({ ...base(), profile });
    expect(r.drafted).toBe(1);
    expect(sent).toEqual([]);
  });

  it('refuses denied recipients without drafting', async () => {
    const profile = validateAgentProfile({
      id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md', channels: ['email'],
      policy: { recipients: { allow: [], deny: ['blocked@example.com'] } },
    });
    put('a.reply.eml', 'blocked@example.com');
    const r = await sendEmailOutbox({ ...base(), profile });
    expect(r.refused).toBe(1);
    expect(r.details[0]?.reason).toBe('recipient-denied');
    expect(await listDrafts({ runsDir: runs })).toEqual([]);
    expect(existsSync(join(outbox, 'a.reply.eml'))).toBe(true);
  });

  it('refuses outside recipients when the profile does not list email', async () => {
    const profile = validateAgentProfile({ id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md', channels: [] });
    put('a.reply.eml', 'outside@example.com');
    const r = await sendEmailOutbox({ ...base(), profile });
    expect(r.refused).toBe(1);
    expect(r.details[0]?.reason).toBe('channel-not-listed');
  });

  it('still sends to the verified allowlisted self address', async () => {
    put('a.reply.eml', 'self@example.com');
    const r = await sendEmailOutbox(base());
    expect(r.sent).toBe(1);
    expect(sent).toEqual(['self@example.com']);
    expect(readdirSync(join(outbox, 'sent'))).toEqual(['a.reply.eml']);
  });
});
