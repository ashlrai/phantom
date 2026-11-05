/**
 * RQ-PHX-EMAILCLIMETADATAPARITY04SQW2 — `ashlr fleet email-outbox --metadata-only`:
 * the shell twin of the fleet_email_outbox MCP tool. Same saved-config resolution,
 * same bounded metadata rows and honest sourceState, and no recipient, subject,
 * body, absolute path or transport text in either text or JSON output.
 *
 * Hermetic: temp-dir runs roots, fake addresses, captured console output and a
 * send transport that throws if ever called. No mail, daemon or provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetEmailOutbox } from '../src/cli/fleet-email-outbox.js';
import { EMAIL_DROP_CONFIG_FILE, writeEmailDropConfig, type EmailDropConfig } from '../src/core/comms/email-drop-config.js';
import type { EmailTransport } from '../src/core/comms/email-outbox.js';

const recipient = 'operator@example.test';
const stranger = 'stranger@example.test';
const bodySentinel = 'SENTINEL-BODY-04sqw2';
const subjectSentinel = 'SENTINEL-SUBJECT-04sqw2';

let root: string;
let runsDir: string;
let outboxDir: string;
let logs: string[];
let errors: string[];
let oldHome: string | undefined;
let oldAshlrHome: string | undefined;

/** A send transport that must never run on the metadata path. */
const throwingTransport: EmailTransport = async () => {
  throw new Error('transport must not be called in --metadata-only mode');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outbox-metadata-'));
  oldHome = process.env.HOME; oldAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = join(root, 'home'); process.env.ASHLR_HOME = join(root, 'home', '.ashlr');
  runsDir = join(root, 'runs');
  outboxDir = join(root, 'outbox');
  mkdirSync(runsDir, { recursive: true });
  logs = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldAshlrHome === undefined) delete process.env.ASHLR_HOME; else process.env.ASHLR_HOME = oldAshlrHome;
  rmSync(root, { recursive: true, force: true });
});

/** Saves the email-drop config; pass `outboxDir: undefined` to exercise the inboxDir-sibling fallback. */
async function saveConfig(overrides: Partial<EmailDropConfig> = {}): Promise<void> {
  await writeEmailDropConfig(runsDir, { v: 1, inboxDir: join(root, 'inbox'), outboxDir, from: [recipient], ...overrides });
}

function writeReply(dir: string, name: string, to: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), `To: ${to}\r\nSubject: ${subjectSentinel}\r\n\r\n${bodySentinel}\r\n`, { mode: 0o600 });
}

/** Runs the command and returns the captured console output and exit code. */
async function run(args: string[], transport: EmailTransport = throwingTransport) {
  const code = await cmdFleetEmailOutbox(args, { runsDir, transport });
  return { code, stdout: logs.join('\n'), stderr: errors.join('\n') };
}

/** Text and JSON must never carry recipients, subjects, bodies, paths or transport text. */
function expectSanitized(output: string): void {
  for (const sentinel of [recipient, stranger, bodySentinel, subjectSentinel, root, 'transport must not']) {
    expect(output).not.toContain(sentinel);
  }
}

type Report = {
  schemaVersion: number; sourceState: string; configEnabled: boolean | null; sendReplies: boolean | null;
  counts: { queued: number; drafted: number; sent: number; stuck: number } | null;
  total: number | null; returned: number | null; truncated: boolean | null;
  entries: Array<{ name: string; state: string; reason?: string }> | null;
};
const parseReport = (stdout: string): Report => JSON.parse(stdout) as Report;

describe('fleet email-outbox --metadata-only: healthy outbox', () => {
  it('reports an empty healthy outbox with exit 0 in JSON and text', async () => {
    await saveConfig();
    mkdirSync(outboxDir, { recursive: true });
    const json = await run(['--metadata-only', '--json']);
    expect(json.code).toBe(0);
    expect(parseReport(json.stdout)).toMatchObject({
      schemaVersion: 1, sourceState: 'ok', configEnabled: true, sendReplies: false,
      counts: { queued: 0, drafted: 0, sent: 0, stuck: 0 }, total: 0, returned: 0, truncated: false, entries: [],
    });
    logs = [];
    const text = await run(['--metadata-only']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('source=ok enabled=true sendReplies=false');
    expect(text.stdout).toContain('queued=0 drafted=0 sent=0 stuck=0 total=0 returned=0 truncated=no');
    expect(text.stderr).toBe('');
  });

  it('lists queued, drafted, sent and stuck rows without recipients, subjects, bodies or paths', async () => {
    await saveConfig();
    writeReply(outboxDir, 'queued-one.reply.eml', recipient);
    writeReply(join(outboxDir, 'drafted'), 'drafted-one.reply.eml', stranger);
    writeReply(join(outboxDir, 'sent'), 'sent-one.reply.eml', recipient);
    writeReply(join(outboxDir, 'sending'), 'orphan.reply.eml', recipient);

    const json = await run(['--metadata-only', '--json']);
    expect(json.code).toBe(0);
    expectSanitized(json.stdout);
    const report = parseReport(json.stdout);
    expect(report.counts).toEqual({ queued: 1, drafted: 1, sent: 1, stuck: 1 });
    expect(report.total).toBe(4);
    expect(report.entries).toHaveLength(4);
    const byName = Object.fromEntries(report.entries!.map((entry) => [entry.name, entry]));
    expect(byName['queued-one.reply.eml']).toEqual({ name: 'queued-one.reply.eml', state: 'queued' });
    expect(byName['drafted-one.reply.eml']).toEqual({ name: 'drafted-one.reply.eml', state: 'drafted' });
    expect(byName['sent-one.reply.eml']).toEqual({ name: 'sent-one.reply.eml', state: 'sent' });
    expect(byName['orphan.reply.eml']).toEqual({ name: 'orphan.reply.eml', state: 'stuck', reason: 'interrupted-send' });
    for (const row of report.entries!) expect(Object.keys(row).sort()).not.toContain('to');

    logs = [];
    const text = await run(['--metadata-only']);
    expect(text.code).toBe(0);
    expectSanitized(text.stdout);
    expect(text.stdout).toContain('queued=1 drafted=1 sent=1 stuck=1 total=4 returned=4 truncated=no');
    expect(text.stdout).toContain('  stuck orphan.reply.eml (interrupted-send)');
    expect(text.stdout).toContain('  queued queued-one.reply.eml');
  });

  it('resolves the outbox next to inboxDir when outboxDir is not saved', async () => {
    await saveConfig({ outboxDir: undefined });
    writeReply(outboxDir, 'fallback.reply.eml', recipient);
    const { code, stdout } = await run(['--metadata-only', '--json']);
    expect(code).toBe(0);
    expect(parseReport(stdout).counts).toEqual({ queued: 1, drafted: 0, sent: 0, stuck: 0 });
    expectSanitized(stdout);
  });
});

describe('fleet email-outbox --metadata-only: limits', () => {
  it('truncates rows to --limit while counts describe the full listing', async () => {
    await saveConfig();
    for (const name of ['a', 'b', 'c']) writeReply(outboxDir, `${name}.reply.eml`, recipient);
    const { code, stdout } = await run(['--metadata-only', '--limit', '2', '--json']);
    expect(code).toBe(0);
    const report = parseReport(stdout);
    expect(report).toMatchObject({ sourceState: 'ok', counts: { queued: 3, drafted: 0, sent: 0, stuck: 0 }, total: 3, returned: 2, truncated: true });
    expect(report.entries).toHaveLength(2);
    expectSanitized(stdout);

    logs = [];
    const text = await run(['--metadata-only', '--limit', '2']);
    expect(text.stdout).toContain('queued=3 drafted=0 sent=0 stuck=0 total=3 returned=2 truncated=yes');
    expect(text.stdout.split('\n').filter((line) => line.startsWith('  queued'))).toHaveLength(2);
    expectSanitized(text.stdout);
  });

  it('accepts the 1 and 200 bounds, and defaults to 50 when --limit is absent', async () => {
    await saveConfig();
    mkdirSync(outboxDir, { recursive: true });
    for (const limit of ['1', '200']) {
      logs = [];
      const { code, stdout } = await run(['--metadata-only', '--limit', limit, '--json']);
      expect(code).toBe(0);
      expect(parseReport(stdout)).toMatchObject({ sourceState: 'ok' });
    }
    logs = [];
    const { stdout } = await run(['--metadata-only', '--json']);
    expect(parseReport(stdout)).toMatchObject({ sourceState: 'ok', entries: [] });
  });

  it.each([
    ['0'], ['201'], ['-1'], ['1.5'], ['1e2'], ['abc'], [' 2'], ['--json'],
  ])('rejects --limit %s with exit 2 and no output report', async (limit) => {
    await saveConfig();
    mkdirSync(outboxDir, { recursive: true });
    const { code, stdout, stderr } = await run(['--metadata-only', '--limit', limit, '--json']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('--limit requires an integer from 1 to 200');
  });

  it('rejects a missing --limit value and a duplicate --limit with exit 2', async () => {
    await saveConfig();
    mkdirSync(outboxDir, { recursive: true });
    expect((await run(['--metadata-only', '--limit'])).code).toBe(2);
    logs = []; errors = [];
    const duplicate = await run(['--metadata-only', '--limit', '1', '--limit', '1']);
    expect(duplicate.code).toBe(2);
    expect(duplicate.stderr).toContain('duplicate option: --limit');
    expect(duplicate.stdout).toBe('');
  });
});

describe('fleet email-outbox --metadata-only: unavailable sources stay honest', () => {
  it('reports a missing saved config as missing-config with exit 2 and null evidence', async () => {
    const { code, stdout, stderr } = await run(['--metadata-only', '--json']);
    expect(code).toBe(2);
    expect(parseReport(stdout)).toMatchObject({
      schemaVersion: 1, sourceState: 'missing-config', configEnabled: null, sendReplies: null,
      counts: null, total: null, returned: null, truncated: null, entries: null,
    });
    expect(stderr).toBe('');
    expectSanitized(stdout);
    logs = []; errors = [];
    const text = await run(['--metadata-only']);
    expect(text.code).toBe(2);
    expect(text.stderr).toBe('email-outbox: source=missing-config enabled=unknown sendReplies=unknown');
    expect(text.stdout).toBe('');
  });

  it('reports an invalid saved config as invalid-config with exit 2 and no path', async () => {
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, EMAIL_DROP_CONFIG_FILE), '{not json', { mode: 0o600 });
    const { code, stdout } = await run(['--metadata-only', '--json']);
    expect(code).toBe(2);
    expect(parseReport(stdout)).toMatchObject({ sourceState: 'invalid-config', configEnabled: null, counts: null, entries: null });
    expectSanitized(stdout);
    expect(stdout).not.toContain(runsDir);
  });

  it('reports a missing outbox directory as missing-outbox with exit 1, keeping saved flags', async () => {
    await saveConfig();
    const { code, stdout } = await run(['--metadata-only', '--json']);
    expect(code).toBe(1);
    expect(parseReport(stdout)).toMatchObject({
      sourceState: 'missing-outbox', configEnabled: true, sendReplies: false, counts: null, entries: null,
    });
    expect(existsSync(outboxDir)).toBe(false);
    expectSanitized(stdout);
  });

  it('reports an outbox path that is not a directory as unreadable-outbox with exit 1', async () => {
    await saveConfig();
    writeFileSync(outboxDir, 'not a directory', { mode: 0o600 });
    const { code, stdout } = await run(['--metadata-only', '--json']);
    expect(code).toBe(1);
    expect(parseReport(stdout)).toMatchObject({ sourceState: 'unreadable-outbox', counts: null, entries: null });
    expectSanitized(stdout);
  });
});

describe('fleet email-outbox --metadata-only: read-only and option rules', () => {
  it('rejects --send with exit 2 before any transport call and leaves the queue untouched', async () => {
    await saveConfig();
    writeReply(outboxDir, 'stay.reply.eml', recipient);
    const transport = vi.fn(throwingTransport);
    const { code, stderr } = await run(['--metadata-only', '--send'], transport);
    expect(code).toBe(2);
    expect(transport).not.toHaveBeenCalled();
    expect(stderr).toContain('cannot be combined with --send or --dir');
    expect(existsSync(join(outboxDir, 'stay.reply.eml'))).toBe(true);
    expect(existsSync(join(outboxDir, 'sent'))).toBe(false);
  });

  it('rejects --dir with exit 2 before any filesystem read of that directory', async () => {
    await saveConfig();
    const elsewhere = join(root, 'elsewhere');
    const { code, stderr } = await run(['--metadata-only', '--dir', elsewhere]);
    expect(code).toBe(2);
    expect(stderr).toContain('cannot be combined with --send or --dir');
    expect(existsSync(elsewhere)).toBe(false);
  });

  it('rejects --limit without --metadata-only with exit 2 and never sends', async () => {
    await saveConfig();
    writeReply(outboxDir, 'stay.reply.eml', recipient);
    const transport = vi.fn(throwingTransport);
    const { code, stderr } = await run(['--limit', '5'], transport);
    expect(code).toBe(2);
    expect(stderr).toContain('--limit requires --metadata-only');
    expect(transport).not.toHaveBeenCalled();
    expect(existsSync(join(outboxDir, 'stay.reply.eml'))).toBe(true);
  });

  it('rejects unknown options alongside --metadata-only with exit 2', async () => {
    await saveConfig();
    const { code } = await run(['--metadata-only', '--bogus']);
    expect(code).toBe(2);
    expect(logs).toEqual([]);
  });

  it('is read-only: a throwing transport is never reached and the outbox is not mutated', async () => {
    await saveConfig();
    writeReply(outboxDir, 'queued.reply.eml', recipient);
    const transport = vi.fn(throwingTransport);
    const { code } = await run(['--metadata-only', '--json'], transport);
    expect(code).toBe(0);
    expect(transport).not.toHaveBeenCalled();
    expect(existsSync(join(outboxDir, 'queued.reply.eml'))).toBe(true);
    expect(existsSync(join(outboxDir, 'sent'))).toBe(false);
    expect(existsSync(join(outboxDir, 'sending'))).toBe(false);
  });
});

describe('fleet email-outbox help', () => {
  it('describes both listing modes, the metadata limits and exit codes', async () => {
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: ashlr fleet email-outbox [--dir <dir>] [--send] [--json]');
    expect(stdout).toContain('ashlr fleet email-outbox --metadata-only [--limit <1-200>] [--json]');
    expect(stdout).toContain('--metadata-only is read-only');
    expect(stdout).toContain('--dir and --send are rejected');
    expect(stdout).toContain('default 50, 1-200');
    expect(stdout).toContain('--limit is valid only with --metadata-only');
    expect(stdout).toContain('Exit 0 when the outbox is readable');
    expect(stdout).toContain('2 when the saved config is missing or');
    expect(stdout).toContain('1 when the outbox is missing or unreadable');
  });
});
