import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { appendBusInbox, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';
import { registerAgentIdentity, stableAgentId } from '../src/core/agents/bus-identity.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bus-read-identity-')); roots.push(dir);
  return { dir, options: { root: join(dir, 'store'), now: () => 100 } satisfies BusInboxOptions };
}

function message(id: string, from: string, to: string) {
  return { id, from, to, priority: 'P1', ttl: 1000, body: `payload-${id}` };
}

function register(options: BusInboxOptions, handle: string, aliases: string[] = []): void {
  expect(registerAgentIdentity({ handle, aliases }, { root: options.root }).status).toBe('created');
}

async function read(options: BusInboxOptions, args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return page.messages.map((row: { envelope: { id: string } }) => row.envelope.id);
}

it('matches --to, --from and --exclude-from under every label of one identity', async () => {
  const { options } = setup();
  register(options, 'worker', ['w-ops']);
  register(options, 'bot', ['bot-main']);
  const workerLabels = ['agent:worker', 'worker', 'w-ops', stableAgentId('worker')];
  const botLabels = ['agent:bot', 'bot', 'bot-main'];
  const rows = [
    ...workerLabels.map((to, i) => message(`w${i}`, 'agent:bot', to)),
    ...botLabels.map((from, i) => message(`b${i}`, from, 'agent:worker')),
    message('other', 'leader', 'agent:worker'),
    message('miss', 'agent:worker', 'elsewhere'),
  ];
  for (const row of rows) expect(appendBusInbox(row, options).status).toBe('posted');

  // Any spelling of the worker identity as --to finds mail under every label.
  for (const filter of ['agent:worker', 'worker', 'w-ops', stableAgentId('worker')]) {
    expect(await read(options, ['--to', filter])).toEqual(['w0', 'w1', 'w2', 'w3', 'b0', 'b1', 'b2', 'other']);
  }
  // --from resolves the same way: every bot label is one sender identity.
  for (const filter of ['agent:bot', 'bot', 'bot-main']) {
    expect(await read(options, ['--from', filter])).toEqual(['w0', 'w1', 'w2', 'w3', 'b0', 'b1', 'b2']);
  }
  // --exclude-from drops every label of that sender identity.
  expect(await read(options, ['--exclude-from', 'agent:bot'])).toEqual(['other', 'miss']);
  expect(await read(options, ['--to', 'agent:worker', '--from', 'w-ops'])).toEqual([]);
  expect(await read(options, ['--to', 'agent:worker', '--from', 'bot-main'])).toEqual(['w0', 'w1', 'w2', 'w3', 'b0', 'b1', 'b2']);
});

it('does not match a different registered identity', async () => {
  const { options } = setup();
  register(options, 'worker');
  register(options, 'impostor', ['impostor-b']);
  for (const row of [message('mine', 'agent:worker', 'agent:worker'),
    message('theirs', 'agent:impostor', 'agent:worker'),
    message('alias', 'impostor-b', 'agent:worker')]) {
    expect(appendBusInbox(row, options).status).toBe('posted');
  }
  expect(await read(options, ['--to', 'agent:worker', '--from', 'agent:worker'])).toEqual(['mine']);
  expect(await read(options, ['--from', 'impostor-b'])).toEqual(['theirs', 'alias']);
});

it('keeps exact-label matching for unresolvable filters and an unreadable registry', async () => {
  const { options, dir } = setup();
  register(options, 'worker', ['w-ops']);
  for (const row of [message('addr', 'agent:worker', 'agent:worker'),
    message('bare', 'worker', 'worker'),
    message('alias', 'w-ops', 'w-ops'),
    message('ghost', 'ghost', 'ghost')]) {
    expect(appendBusInbox(row, options).status).toBe('posted');
  }
  // A filter naming no registered identity matches only the literal label.
  expect(await read(options, ['--to', 'ghost'])).toEqual(['ghost']);
  expect(await read(options, ['--from', 'agent:ghost'])).toEqual([]);

  writeFileSync(join(dir, 'store', 'agent-identities', 'registry.json'), '{invalid', { mode: 0o600 });
  // Without a readable registry only the literal `agent:worker` label matches.
  expect(await read(options, ['--to', 'agent:worker'])).toEqual(['addr']);
  expect(await read(options, ['--to', 'worker'])).toEqual(['bare']);
  expect(await read(options, ['--from', 'w-ops'])).toEqual(['alias']);
});

it('resolves address filters in watch pages too', async () => {
  const { options } = setup();
  register(options, 'worker', ['w-ops']);
  for (const row of [message('one', 'agent:worker', 'agent:worker'),
    message('two', 'w-ops', 'elsewhere'),
    message('three', 'other', 'worker')]) {
    expect(appendBusInbox(row, options).status).toBe('posted');
  }
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--to', 'agent:worker', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['one', 'three']);
});
