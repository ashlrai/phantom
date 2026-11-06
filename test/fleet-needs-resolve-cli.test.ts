import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetNeedsResolve } from '../src/cli/fleet-needs-resolve.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { listNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';

let root: string, itemId: string, out: string[], errors: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fake-needs-cli-'));
  vi.stubEnv('ASHLR_HOME', join(root, 'home'));
  writeFileSync(join(root, 'NEEDS-MASON.md'), '- [ ] Pick a fake color\n');
  itemId = listNeedsMason({ runsDir: root })[0]!.id;
  out = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((message: string) => { out.push(message); });
  vi.spyOn(process.stderr, 'write').mockImplementation((message) => { errors.push(String(message)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const args = () => [itemId, '--runs-dir', root];

it('resolves, relays the reply, and records the CLI source on the bus', async () => {
  expect(await cmdFleetNeedsResolve([...args(), '--reply', 'Use fake blue'])).toBe(0);
  expect(out).toEqual([`Resolved ${itemId}. Reply sent to the planners.`]);
  expect(listNeedsMason({ runsDir: root })).toEqual([]);
  expect(readFileSync(join(root, 'leader', 'MASON-INBOX.md'), 'utf8')).toContain('Use fake blue');
  const page = listBusInboxAfter(0, 100, { root: join(root, 'home', 'fleet') });
  expect(page.status).toBe('ok');
  if (page.status === 'ok') expect(page.messages[0]!.envelope.body).toMatchObject({ kind: 'needs_mason.resolved', itemId, source: 'cli', reply: 'Use fake blue' });
});

it('skips the inbox without a reply and refuses a second resolution', async () => {
  expect(await cmdFleetNeedsResolve(args())).toBe(0);
  expect(existsSync(join(root, 'leader', 'MASON-INBOX.md'))).toBe(false);
  expect(await cmdFleetNeedsResolve(args())).toBe(1);
  expect(errors).toContain('Refused: item already resolved\n');
});

it('refuses unknown IDs and rejects malformed or repeated arguments', async () => {
  expect(await cmdFleetNeedsResolve(['nm-000000000000', '--runs-dir', root])).toBe(1);
  expect(errors).toContain('Refused: unknown item\n');
  for (const bad of [['bad'], [itemId, itemId], [itemId, '--json', '--json'], [itemId, '--reply'], [itemId, '--runs-dir', root, '--runs-dir', root]]) {
    expect(await cmdFleetNeedsResolve(bad)).toBe(2);
  }
  expect(await cmdFleetNeedsResolve(['--help'])).toBe(0);
});

it('prints the versioned JSON result for success and refusal', async () => {
  expect(await cmdFleetNeedsResolve([...args(), '--json'])).toBe(0);
  expect(JSON.parse(out.pop()!)).toEqual({ v: 1, status: 'resolved', itemId, inbox: 'skipped' });
  expect(await cmdFleetNeedsResolve([...args(), '--json'])).toBe(1);
  expect(JSON.parse(out.pop()!)).toEqual({ v: 1, status: 'already-resolved', itemId, inbox: 'skipped' });
});

it('hides thrown error details', async () => {
  expect(await cmdFleetNeedsResolve(args(), { resolve: async () => { throw new Error('fake private path'); } })).toBe(1);
  expect(errors).toEqual(['error: needs-you file unavailable\n']);
});
