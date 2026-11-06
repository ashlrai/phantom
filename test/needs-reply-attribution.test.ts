import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { listNeedsMason, type NeedsMasonOptions } from '../src/core/fleet/needs-mason-resolve.js';
import { resolveNeedsMasonWithInbox } from '../src/core/fleet/needs-mason-relay.js';

let root: string;
let options: NeedsMasonOptions;
let itemId: string;
const now = () => 1_800_000_000_000;
const inboxPath = () => join(root, 'leader', 'MASON-INBOX.md');
const entries = () => (existsSync(inboxPath()) ? parseInbox(readFileSync(inboxPath(), 'utf8')) : []);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fake-reply-attrib-'));
  writeFileSync(join(root, 'NEEDS-MASON.md'), '# Needs Mason\n- [ ] Pick a fake color\n');
  options = { runsDir: root, bus: { root: join(root, 'fake-bus'), now }, now };
  itemId = listNeedsMason(options)[0]!.id;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('labels a Telegram reply as Telegram', async () => {
  expect(await resolveNeedsMasonWithInbox({ itemId, reply: 'fake blue' }, { ...options, source: 'telegram' }))
    .toMatchObject({ ok: true, inbox: 'appended' });
  const text = readFileSync(inboxPath(), 'utf8');
  expect(text).toContain('[src:telegram id:telegram-');
  expect(entries()).toHaveLength(1);
});

it('labels a CLI reply as ashlr CLI', async () => {
  await resolveNeedsMasonWithInbox({ itemId, reply: 'fake blue' }, { ...options, source: 'cli' });
  expect(readFileSync(inboxPath(), 'utf8')).toContain('[src:ashlr-cli ');
  expect(entries()).toHaveLength(1);
});

it('keeps Phantom desktop when no source is given', async () => {
  await resolveNeedsMasonWithInbox({ itemId, reply: 'fake blue' }, options);
  expect(readFileSync(inboxPath(), 'utf8')).toContain('[src:desktop id:desk-');
});

it('appends nothing for a second resolve of the same item', async () => {
  await resolveNeedsMasonWithInbox({ itemId, reply: 'fake blue' }, { ...options, source: 'telegram' });
  expect(await resolveNeedsMasonWithInbox({ itemId, reply: 'fake green' }, { ...options, source: 'telegram' }))
    .toMatchObject({ ok: false, inbox: 'skipped' });
  expect(entries()).toHaveLength(1);
});

it('appends nothing when resolved without a reply', async () => {
  expect(await resolveNeedsMasonWithInbox({ itemId }, { ...options, source: 'telegram' }))
    .toMatchObject({ ok: true, inbox: 'skipped' });
  expect(entries()).toHaveLength(0);
});
