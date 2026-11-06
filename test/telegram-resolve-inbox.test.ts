import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderNeedsCommandReply, runTelegramNeedsCommand } from '../src/core/comms/telegram-needs-command.js';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { listNeedsMason, type NeedsMasonOptions } from '../src/core/fleet/needs-mason-resolve.js';
import { resolveNeedsMasonWithInbox } from '../src/core/fleet/needs-mason-relay.js';

let root: string;
let base: NeedsMasonOptions;
let itemId: string;
const now = () => 1_800_000_000_000;
const inboxPath = () => join(root, 'leader', 'MASON-INBOX.md');
const run = (text: string, extra: Record<string, unknown> = {}) => runTelegramNeedsCommand(text, {
  list: () => listNeedsMason(base),
  resolve: (request, opts) => resolveNeedsMasonWithInbox(request, { ...base, ...opts, ...extra }),
}).then(renderNeedsCommandReply);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fake-tg-resolve-'));
  writeFileSync(join(root, 'NEEDS-MASON.md'), '# Needs Mason\n- [ ] Pick a fake color\n');
  base = { runsDir: root, bus: { root: join(root, 'fake-bus'), now }, now };
  itemId = listNeedsMason(base)[0]!.id;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('lands a Telegram reply in the inbox attributed to telegram', async () => {
  expect(await run(`/resolve ${itemId} use fake blue`)).toBe(`Resolved ${itemId}. Reply sent to the planners.`);
  const text = readFileSync(inboxPath(), 'utf8');
  expect(text).toContain('[src:telegram');
  expect(parseInbox(text)).toMatchObject([{ text: `Re needs-you ${itemId} ("Pick a fake color"): use fake blue` }]);
});

it('skips the inbox when there is no reply', async () => {
  expect(await run(`/resolve ${itemId}`)).toBe(`Resolved ${itemId}.`);
  expect(existsSync(inboxPath())).toBe(false);
});

it('reports an inbox failure but keeps the item resolved', async () => {
  const appendInbox = async () => { throw new Error('/fake/path boom'); };
  const text = await run(`/resolve ${itemId} use fake blue`, { appendInbox });
  expect(text).toBe(`Resolved ${itemId}. Reply did not reach the planner inbox; send it again as a normal message.`);
  expect(listNeedsMason(base)).toEqual([]);
});

it('refuses an already-resolved item without a second entry', async () => {
  await run(`/resolve ${itemId} use fake blue`);
  expect(await run(`/resolve ${itemId} again`)).toBe('Resolve refused: item is already resolved.');
  expect(parseInbox(readFileSync(inboxPath(), 'utf8'))).toHaveLength(1);
});

it.each([[undefined, 'desktop'], ['desktop', 'desktop'], ['cli', 'cli'], ['phone', 'phone']] as const)(
  'tags source %s as src:%s', async (source, tag) => {
    await resolveNeedsMasonWithInbox({ itemId, reply: 'ok' }, { ...base, ...(source ? { source } : {}) });
    expect(readFileSync(inboxPath(), 'utf8')).toContain(`[src:${tag} `);
  });
