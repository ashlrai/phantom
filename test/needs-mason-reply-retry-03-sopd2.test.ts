import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendInboxEntry, parseInbox } from '../src/core/fleet/mason-inbox.js';
import { listNeedsMason, type NeedsMasonOptions } from '../src/core/fleet/needs-mason-resolve.js';
import { resolveNeedsMasonWithInbox } from '../src/core/fleet/needs-mason-relay.js';

let root: string;
let options: NeedsMasonOptions;
let itemId: string;
const now = () => 1_800_000_000_000;
const inboxPath = () => join(root, 'leader', 'MASON-INBOX.md');
const stateDir = () => join(root, 'needs-mason-delivery');
const entries = () => parseInbox(readFileSync(inboxPath(), 'utf8'));
const busFiles = () => readdirSync(join(root, 'fake-bus'), { recursive: true }).join('\n');
const failing = () => vi.fn(async () => ({ ok: false as const, reason: 'write-failed' as const }));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fake-reply-retry-'));
  writeFileSync(join(root, 'NEEDS-MASON.md'), '# Needs Mason\n- [ ] Pick a fake color\n');
  options = { runsDir: root, bus: { root: join(root, 'fake-bus'), now }, now };
  itemId = listNeedsMason(options)[0]!.id;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('retries the original reply once after a failed append', async () => {
  expect(await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, { ...options, appendInbox: failing() }))
    .toMatchObject({ ok: true, inbox: 'failed' });
  const busBefore = busFiles();
  const retry = await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, options);
  expect(retry).toMatchObject({ ok: true, itemId, duplicate: false, inbox: 'appended' });
  expect(retry.deliveryReceipt).toBeUndefined();
  expect(entries()).toMatchObject([{ text: `Re needs-you ${itemId} ("Pick a fake color"): Use fake blue` }]);
  expect(busFiles()).toBe(busBefore);
  expect(listNeedsMason(options)).toEqual([]);
  expect(readFileSync(join(root, 'NEEDS-MASON.md'), 'utf8').match(/resolved nm-/g)).toHaveLength(1);
});

it('does not append twice on repeated calls after delivery', async () => {
  await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, { ...options, appendInbox: failing() });
  await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, options);
  expect(await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, options))
    .toMatchObject({ ok: false, code: 'already-resolved', inbox: 'skipped' });
  expect(entries()).toHaveLength(1);
});

it('delivers the original reply when the retry carries a changed one', async () => {
  await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, { ...options, appendInbox: failing() });
  await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake green' }, options);
  const text = readFileSync(inboxPath(), 'utf8');
  expect(text).toContain('Use fake blue');
  expect(text).not.toContain('fake green');
});

it('still rejects an invalid replacement on retry and keeps the pending reply', async () => {
  await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, { ...options, appendInbox: failing() });
  expect(await resolveNeedsMasonWithInbox({ itemId, reply: 'x'.repeat(501) }, options))
    .toMatchObject({ ok: false, code: 'reply-too-long', inbox: 'skipped' });
  expect(await resolveNeedsMasonWithInbox({ itemId, extra: 1 }, options)).toMatchObject({ ok: false, code: 'invalid' });
  await resolveNeedsMasonWithInbox({ itemId }, options);
  expect(entries()).toHaveLength(1);
});

it.each([[{ itemId: 'nm-000000000000', reply: 'hi' }, 'unknown'], [{ itemId: 'bad', reply: 'hi' }, 'invalid']])(
  'rejects a fresh %j without state or inbox writes', async (input, code) => {
    expect(await resolveNeedsMasonWithInbox(input, options)).toMatchObject({ ok: false, code, inbox: 'skipped' });
    expect(() => readFileSync(inboxPath())).toThrow();
    expect(() => readdirSync(join(stateDir(), 'nm-000000000000.json'))).toThrow();
  });

it('serializes concurrent retries into one append', async () => {
  await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, { ...options, appendInbox: failing() });
  const slow: typeof appendInboxEntry = async (text, opts) => { await new Promise(r => setTimeout(r, 20)); return appendInboxEntry(text, opts); };
  const results = await Promise.all([1, 2, 3].map(() => resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, { ...options, appendInbox: slow })));
  expect(results.filter(r => r.inbox === 'appended')).toHaveLength(1);
  expect(entries()).toHaveLength(1);
});

it('refuses malformed, oversized and symlinked delivery state without resolving', async () => {
  mkdirSync(stateDir());
  const file = join(stateDir(), `${itemId}.json`);
  for (const setup of [() => writeFileSync(file, '{not json'), () => writeFileSync(file, JSON.stringify({ status: 'pending', message: '' })),
    () => writeFileSync(file, ' '.repeat(5000)), () => { rmSync(file); symlinkSync(join(root, 'elsewhere'), file); }]) {
    setup();
    expect(await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, options))
      .toMatchObject({ ok: false, code: 'unavailable', inbox: 'failed' });
    expect(listNeedsMason(options)).toHaveLength(1);
  }
});

it('refuses when delivery storage is unavailable, before resolving', async () => {
  writeFileSync(stateDir(), 'not a directory');
  expect(await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, options))
    .toMatchObject({ ok: false, code: 'unavailable', inbox: 'failed' });
  expect(listNeedsMason(options)).toHaveLength(1);
});

it('reports an unrecorded receipt when persistence fails after a successful append', async () => {
  const appendInbox: typeof appendInboxEntry = async (text, opts) => {
    const out = await appendInboxEntry(text, opts);
    rmSync(stateDir(), { recursive: true, force: true });
    writeFileSync(stateDir(), 'blocked');
    return out;
  };
  expect(await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, { ...options, appendInbox }))
    .toMatchObject({ ok: true, inbox: 'appended', deliveryReceipt: 'unrecorded' });
  expect(entries()).toHaveLength(1);
});

it('never writes the raw reply to the state file after delivery', async () => {
  await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, options);
  expect(readFileSync(join(stateDir(), `${itemId}.json`), 'utf8')).not.toContain('fake blue');
});
