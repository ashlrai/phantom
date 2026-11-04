import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetNeeds } from '../src/cli/fleet-needs.js';
import { listNeedsMason, type NeedsMasonOptions } from '../src/core/fleet/needs-mason-resolve.js';
import { resolveNeedsMasonWithInbox, type NeedsMasonRelayResult } from '../src/core/fleet/needs-mason-relay.js';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';

const now = () => 1_800_000_000_000;
const fakeText = 'Review the fake deployment plan';
const fakeId = `nm-${createHash('sha256').update(fakeText).digest('hex').slice(0, 12)}`;
const multilineReply = 'Line one: approve the changes.\nLine two: notify the team.\nLine three: close the ticket.';
let root: string;
let options: NeedsMasonOptions;
let logOutput: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-needs-cli-reply-03-'));
  writeFileSync(join(root, 'NEEDS-MASON.md'), `# Needs Mason\n- [ ] ${fakeText}\n`);
  options = { runsDir: root, bus: { root: join(root, 'inbox'), now }, now };
  logOutput = [];
  vi.spyOn(console, 'log').mockImplementation((message?: any, ...args: any[]) => {
    logOutput.push(typeof message === 'string' ? message : JSON.stringify(message));
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

// Stub the bus module to always return success, avoiding permission checks on temp dirs
vi.mock('../src/core/fleet/bus-inbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/bus-inbox.js')>();
  return {
    ...actual,
    appendBusInbox: vi.fn().mockReturnValue({ status: 'posted', id: 'test-envelope-id', cursor: 1 }),
  };
});

it('resolves one fake blocker with a multiline reply and the item disappears', async () => {
  const result = await cmdFleetNeeds(['--json', '--runs-dir', root, '--resolve', fakeId, '--reply', multilineReply]);
  expect(result).toBe(0);
  const out = JSON.parse(logOutput[0] ?? '{}');
  expect(out.v).toBe(1);
  expect(out.item).toBe(fakeId);
  expect(out.inbox).toBe('appended');
  expect(listNeedsMason(options)).toHaveLength(0);
});

it('writes a safely formatted CLI-attributed inbox entry', async () => {
  await cmdFleetNeeds(['--json', '--runs-dir', root, '--resolve', fakeId, '--reply', 'Use fake blue']);
  const inboxFile = join(root, 'leader', 'MASON-INBOX.md');
  expect(existsSync(inboxFile)).toBe(true);
  const entries = parseInbox(readFileSync(inboxFile, 'utf8'));
  expect(entries).toHaveLength(1);
  expect(entries[0]!.text).toContain(`Re needs-you ${fakeId}`);
  expect(entries[0]!.text).toContain(fakeText.slice(0, 160));
  expect(entries[0]!.text).toContain('Use fake blue');
  // CLI attribution includes the channel slug: "cli (cli-<16hex>)"
  expect(entries[0]!.source).toMatch(/^cli \(cli-/);
});

it('leaves the default home runs directory untouched', async () => {
  const homeRuns = join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.ashlr-runs');
  const before = existsSync(join(homeRuns, 'NEEDS-MASON.md')) ? readFileSync(join(homeRuns, 'NEEDS-MASON.md'), 'utf8') : null;
  await cmdFleetNeeds(['--json', '--runs-dir', root, '--resolve', fakeId, '--reply', 'Use fake blue']);
  const after = existsSync(join(homeRuns, 'NEEDS-MASON.md')) ? readFileSync(join(homeRuns, 'NEEDS-MASON.md'), 'utf8') : null;
  expect(after).toBe(before);
});

it('rejects a second resolution without duplicating inbox entries', async () => {
  const inboxFile = join(root, 'leader', 'MASON-INBOX.md');
  expect(existsSync(inboxFile)).toBe(false);
  const result = await resolveNeedsMasonWithInbox({ itemId: fakeId, reply: 'First pass' }, options);
  expect(result.ok).toBe(true);
  expect(existsSync(inboxFile)).toBe(true);
  const firstEntries = parseInbox(readFileSync(inboxFile, 'utf8'));
  expect(firstEntries).toHaveLength(1);
  const second = await resolveNeedsMasonWithInbox({ itemId: fakeId, reply: 'Second pass' }, options);
  expect(second.ok).toBe(false);
  expect(second.code).toBe('already-resolved');
  expect(second.inbox).toBe('skipped');
  // Second resolution should not create another inbox entry
  expect(parseInbox(readFileSync(inboxFile, 'utf8'))).toHaveLength(1);
});

it('rejects invalid arguments without mutating files', async () => {
  const listSpy = vi.fn(() => [{ id: fakeId, text: fakeText }]);
  const result1 = await cmdFleetNeeds(['--resolve', 'not-a-real-id'], { list: listSpy });
  expect(result1).toBe(2);
  expect(listSpy).not.toHaveBeenCalled();
  const result2 = await cmdFleetNeeds(['--reply', 'no resolve']);
  expect(result2).toBe(2);
  expect(readFileSync(join(root, 'NEEDS-MASON.md'), 'utf8')).toContain(fakeText);
});

it('returns nonzero for a missing item', async () => {
  const result = await cmdFleetNeeds(['--json', '--runs-dir', root, '--resolve', 'nm-000000000000', '--reply', 'Try fake red']);
  expect(result).toBe(1);
  const out = JSON.parse(logOutput[0] ?? '{}');
  expect(out.error).toBeDefined();
  expect(listNeedsMason(options)).toHaveLength(1);
});

it('shows partial delivery when inbox append fails', async () => {
  const failInbox = vi.fn(async () => ({ ok: false, reason: 'write-failed' as const }));
  const resolve: typeof resolveNeedsMasonWithInbox = (input: unknown, opts: { appendInbox?: typeof failInbox } & NeedsMasonOptions) =>
    resolveNeedsMasonWithInbox(input, { ...opts, appendInbox: failInbox });
  const result = await cmdFleetNeeds(['--json', '--runs-dir', root, '--resolve', fakeId, '--reply', 'Use fake red'], { resolve });
  expect(result).toBe(0);
  const out = JSON.parse(logOutput[0] ?? '{}');
  expect(out.inbox).toBe('failed');
  expect(listNeedsMason(options)).toHaveLength(0);
});
