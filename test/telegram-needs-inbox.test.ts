import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runTelegramNeedsCommand } from '../src/core/comms/telegram-needs-command.js';
import { listNeedsMason, type NeedsMasonOptions } from '../src/core/fleet/needs-mason-resolve.js';
import { resolveNeedsMasonWithInbox } from '../src/core/fleet/needs-mason-relay.js';

let root: string;
let base: NeedsMasonOptions;
let itemId: string;
const now = () => 1_800_000_000_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fake-tg-inbox-'));
  writeFileSync(join(root, 'NEEDS-MASON.md'), '# Needs Mason\n- [ ] Pick a fake color\n');
  base = { runsDir: root, bus: { root: join(root, 'fake-bus'), now }, now };
  itemId = listNeedsMason(base)[0]!.id;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('a Telegram /resolve with a reply resolves and reaches MASON-INBOX.md', async () => {
  const reply = await runTelegramNeedsCommand(`/resolve ${itemId} ship it`, {
    list: () => listNeedsMason(base),
    resolve: (request, opts) => resolveNeedsMasonWithInbox(request, { ...base, ...opts }),
  });
  expect(reply).toMatchObject({ status: 'resolved', itemId });
  const inbox = readFileSync(join(root, 'leader', 'MASON-INBOX.md'), 'utf8');
  expect(inbox).toContain('[src:telegram ');
  expect(inbox).toContain('ship it');
});

it('a rejecting async resolve yields a failed reply without error text', async () => {
  const reply = await runTelegramNeedsCommand(`/resolve ${itemId} ship it`, {
    list: () => [],
    resolve: async () => { throw new Error('/secret/fake/path exploded'); },
  });
  expect(reply).toEqual({ status: 'failed', command: 'resolve' });
  expect(JSON.stringify(reply)).not.toContain('exploded');
});
