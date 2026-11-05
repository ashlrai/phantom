import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseEmailDrop, type EmailDiagnosis } from '../src/core/comms/email-diagnosis.js';
import { EMAIL_DROP_CONFIG_FILE, writeEmailDropConfig, type EmailDropConfig } from '../src/core/comms/email-drop-config.js';
import { cmdCommsDiagnose } from '../src/cli/comms-diagnose.js';

let root: string;
let oldHome: string | undefined;
let oldAshlrHome: string | undefined;
let home: string;
let runsDir: string;
let inboxDir: string;
let outboxDir: string;
let logs: string[];
let errors: string[];

const sender = 'operator@example.test';
const replyEml = (to = sender) => `To: ${to}\r\nSubject: Re: private subject\r\n\r\nreply body text\r\n`;
const COVERAGE = 'local-evidence-only-not-gmail-triage-or-proof-of-delivery';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'email-diagnosis-'));
  oldHome = process.env.HOME; oldAshlrHome = process.env.ASHLR_HOME;
  home = join(root, 'home');
  process.env.HOME = home; process.env.ASHLR_HOME = join(home, '.ashlr');
  runsDir = join(root, 'runs');
  inboxDir = join(root, 'drop', 'inbox');
  outboxDir = join(root, 'drop', 'outbox'); // also join(inboxDir, '..', 'outbox')
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

const saveConfig = (overrides: Partial<EmailDropConfig> = {}) =>
  writeEmailDropConfig(runsDir, { v: 1, inboxDir, outboxDir, from: [sender], ...overrides });
const dropReply = (dir: string, name: string, to?: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.reply.eml`), replyEml(to));
};
const check = (diagnosis: EmailDiagnosis, id: string) => {
  const found = diagnosis.checks.find((entry) => entry.id === id);
  expect(found, `expected check ${id}`).toBeDefined();
  return found!;
};

describe('diagnoseEmailDrop', () => {
  it('reports missing or invalid config without evaluating the rest', async () => {
    const missing = await diagnoseEmailDrop(runsDir);
    expect(missing).toMatchObject({
      config: 'missing', polling: 'unknown', sendReplies: 'unknown',
      outbox: 'not-established', counts: null, replies: 'not-configured', coverage: COVERAGE,
    });
    expect(missing.checks).toHaveLength(4);
    expect(check(missing, 'email-config')).toMatchObject({ state: 'unavailable', reason: 'email-config-missing', nextStep: 'phm comms setup-email' });
    for (const id of ['email-polling', 'email-send', 'email-outbox']) {
      expect(check(missing, id)).toMatchObject({ state: 'unavailable', reason: 'unknown-config-unusable' });
    }
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, EMAIL_DROP_CONFIG_FILE), '{"v":2}\n');
    const invalid = await diagnoseEmailDrop(runsDir);
    expect(invalid.config).toBe('invalid');
    expect(invalid.replies).toBe('not-configured');
    expect(check(invalid, 'email-config')).toMatchObject({ state: 'unavailable', reason: 'email-config-invalid' });
  });

  it('reports paused polling as blocked', async () => {
    await saveConfig({ enabled: false });
    const diagnosis = await diagnoseEmailDrop(runsDir);
    expect(diagnosis.polling).toBe('paused');
    expect(diagnosis.replies).toBe('paused');
    expect(check(diagnosis, 'email-config')).toMatchObject({ state: 'ok', reason: 'email-config-present' });
    expect(check(diagnosis, 'email-polling')).toMatchObject({ state: 'blocked', reason: 'email-polling-paused', nextStep: 'phm comms setup-email' });
  });

  it('distinguishes deliberate draft-only from replies awaiting the send cycle', async () => {
    // No outboxDir in config: exercises the same default the cycle uses.
    await writeEmailDropConfig(runsDir, { v: 1, inboxDir, from: [sender] });
    dropReply(outboxDir, 'held');
    const draftOnly = await diagnoseEmailDrop(runsDir);
    expect(draftOnly.sendReplies).toBe('disabled');
    expect(draftOnly.replies).toBe('draft-only');
    expect(draftOnly.outbox).toBe('ok');
    expect(draftOnly.counts).toEqual({ queued: 1, drafted: 0, sent: 0, stuck: 0 });
    expect(check(draftOnly, 'email-send')).toMatchObject({ state: 'unsupported', reason: 'send-replies-disabled-draft-only', nextStep: 'phm comms setup-email' });
    expect(check(draftOnly, 'email-outbox')).toMatchObject({ state: 'ok', reason: 'queued-replies-held-send-disabled', nextStep: 'phm fleet email-outbox --json' });

    await saveConfig({ sendReplies: true });
    const sending = await diagnoseEmailDrop(runsDir);
    expect(sending.replies).toBe('send-enabled');
    expect(check(sending, 'email-send')).toMatchObject({ state: 'ok', reason: 'send-replies-enabled' });
    expect(check(sending, 'email-outbox')).toMatchObject({ state: 'ok', reason: 'queued-replies-await-send-cycle', nextStep: 'phm comms email-cycle' });
  });

  it('never lets a missing, non-directory or unreadable outbox look healthy-empty', async () => {
    await saveConfig({ sendReplies: true });
    const missing = await diagnoseEmailDrop(runsDir);
    expect(missing.outbox).toBe('missing');
    expect(missing.counts).toBeNull();
    expect(missing.replies).toBe('blocked');
    expect(check(missing, 'email-outbox')).toMatchObject({ state: 'unavailable', reason: 'email-outbox-missing', nextStep: 'phm comms setup-email' });

    mkdirSync(join(outboxDir, '..'), { recursive: true });
    writeFileSync(outboxDir, 'not a directory');
    const notDirectory = await diagnoseEmailDrop(runsDir);
    expect(notDirectory.outbox).toBe('not-directory');
    expect(notDirectory.counts).toBeNull();
    expect(check(notDirectory, 'email-outbox')).toMatchObject({ state: 'unavailable', reason: 'email-outbox-not-directory' });
    rmSync(outboxDir);

    mkdirSync(outboxDir, { recursive: true });
    chmodSync(outboxDir, 0);
    try {
      const unreadable = await diagnoseEmailDrop(runsDir);
      expect(unreadable.outbox).toBe('unreadable');
      expect(unreadable.counts).toBeNull();
      expect(unreadable.replies).toBe('blocked');
      expect(check(unreadable, 'email-outbox')).toMatchObject({ state: 'unavailable', reason: 'email-outbox-unreadable' });
    } finally {
      chmodSync(outboxDir, 0o700);
    }
  });

  it('counts queued, drafted, sent and stuck artifacts distinctly', async () => {
    await saveConfig({ sendReplies: true });
    mkdirSync(outboxDir, { recursive: true });
    const empty = await diagnoseEmailDrop(runsDir);
    expect(empty.counts).toEqual({ queued: 0, drafted: 0, sent: 0, stuck: 0 });
    expect(empty.replies).toBe('send-enabled');
    expect(check(empty, 'email-outbox')).toMatchObject({ state: 'ok', reason: 'no-replies-observed' });

    dropReply(join(outboxDir, 'sending'), 'orphan');
    const stuck = await diagnoseEmailDrop(runsDir);
    expect(stuck.counts).toEqual({ queued: 0, drafted: 0, sent: 0, stuck: 1 });
    expect(stuck.replies).toBe('blocked');
    expect(check(stuck, 'email-outbox')).toMatchObject({ state: 'blocked', reason: 'stuck-replies-observed', nextStep: 'phm fleet email-outbox --json' });

    rmSync(join(outboxDir, 'sending'), { recursive: true });
    dropReply(join(outboxDir, 'drafted'), 'held');
    const drafted = await diagnoseEmailDrop(runsDir);
    expect(drafted.counts).toEqual({ queued: 0, drafted: 1, sent: 0, stuck: 0 });
    expect(check(drafted, 'email-outbox')).toMatchObject({ state: 'ok', reason: 'drafted-replies-await-approval', nextStep: 'phm drafts list --status pending --json' });

    rmSync(join(outboxDir, 'drafted'), { recursive: true });
    dropReply(join(outboxDir, 'sent'), 'done');
    const sent = await diagnoseEmailDrop(runsDir);
    expect(sent.counts).toEqual({ queued: 0, drafted: 0, sent: 1, stuck: 0 });
    expect(check(sent, 'email-outbox')).toMatchObject({ state: 'ok', reason: 'sent-replies-observed' });
  });

  it('degrades injected readers to fixed codes, never their internals', async () => {
    const missing = await diagnoseEmailDrop(join(root, 'unused'), {
      readConfig: async () => ({ state: 'missing', path: join(root, 'secret-config-path') }),
    });
    expect(missing.config).toBe('missing');
    expect(JSON.stringify(missing)).not.toContain('secret-config-path');
    const thrown = await diagnoseEmailDrop(join(root, 'unused'), {
      readConfig: async () => { throw new Error('reader exploded'); },
    });
    expect(thrown.config).toBe('invalid');
    expect(check(thrown, 'email-config')).toMatchObject({ state: 'unavailable', reason: 'email-config-invalid' });
    expect(JSON.stringify(thrown)).not.toContain('reader exploded');
  });
});

describe('cmdCommsDiagnose email leg', () => {
  it('adds email checks and structured evidence to --json while preserving existing fields', async () => {
    await saveConfig({ sendReplies: true });
    dropReply(outboxDir, 'queued-one');
    dropReply(join(outboxDir, 'sent'), 'sent-one');
    dropReply(join(outboxDir, 'sending'), 'stuck-one');
    const code = await cmdCommsDiagnose(true, { runsDir });
    expect(code).toBe(1);
    const result = JSON.parse(logs[0]!);
    expect(result.schemaVersion).toBe(1);
    expect(result.readOnly).toBe(true);
    for (const field of ['transport', 'enabled', 'configured', 'credential', 'requests', 'checks']) {
      expect(result).toHaveProperty(field);
    }
    expect(result.email).toEqual({
      config: 'ok', polling: 'enabled', sendReplies: 'enabled', outbox: 'ok',
      counts: { queued: 1, drafted: 0, sent: 1, stuck: 1 }, replies: 'blocked', coverage: COVERAGE,
    });
    const ids = result.checks.map((entry: { id: string }) => entry.id);
    expect(ids).toContain('requests');
    expect(ids.indexOf('email-config')).toBeGreaterThan(ids.indexOf('local-receiver'));
    expect(ids.indexOf('email-polling')).toBe(ids.indexOf('email-config') + 1);
    expect(ids.indexOf('email-send')).toBe(ids.indexOf('email-polling') + 1);
    expect(ids.indexOf('email-outbox')).toBe(ids.indexOf('email-send') + 1);
    expect(ids.at(-1)).toBe('delivery');
    expect(result.checks.find((entry: { id: string }) => entry.id === 'email-outbox'))
      .toMatchObject({ state: 'blocked', reason: 'stuck-replies-observed' });
  });

  it('projects no paths, addresses, subjects or body text in json or text', async () => {
    await saveConfig({ sendReplies: true });
    dropReply(outboxDir, 'q', 'stranger@example.test');
    await cmdCommsDiagnose(true, { runsDir });
    await cmdCommsDiagnose(false, { runsDir });
    const out = logs.join('\n');
    for (const marker of [root, outboxDir, inboxDir, runsDir, sender,
      'stranger@example.test', 'private subject', 'reply body text', EMAIL_DROP_CONFIG_FILE]) {
      expect(out).not.toContain(marker);
    }
  });

  it('prints the counts line and the local-evidence scope in text mode', async () => {
    await saveConfig({ sendReplies: true });
    dropReply(outboxDir, 'q');
    await cmdCommsDiagnose(false, { runsDir });
    const out = logs.join('\n');
    expect(out).toContain('email-outbox-counts: queued=1 drafted=0 sent=0 stuck=0 (local evidence only)');
    expect(out).toContain('email: config and counts are local evidence only; not Gmail triage coverage or proof of delivery');
    expect(out).toContain('email-send: ok (send-replies-enabled)');
    expect(out).toContain('email-outbox: ok (queued-replies-await-send-cycle)');
  });

  it('merges an injected collector and survives a throwing one', async () => {
    const seen: string[] = [];
    await cmdCommsDiagnose(true, {
      runsDir,
      diagnoseEmail: async (dir) => {
        seen.push(dir);
        return {
          config: 'ok', polling: 'enabled', sendReplies: 'disabled', outbox: 'ok',
          counts: { queued: 2, drafted: 0, sent: 0, stuck: 0 }, replies: 'draft-only', coverage: COVERAGE,
          checks: [{ id: 'email-send', state: 'unsupported', reason: 'send-replies-disabled-draft-only', nextStep: 'phm comms setup-email' }],
        };
      },
    });
    expect(seen).toEqual([runsDir]);
    const result = JSON.parse(logs[0]!);
    expect(result.email).toEqual({
      config: 'ok', polling: 'enabled', sendReplies: 'disabled', outbox: 'ok',
      counts: { queued: 2, drafted: 0, sent: 0, stuck: 0 }, replies: 'draft-only', coverage: COVERAGE,
    });
    expect(result.checks.find((entry: { id: string }) => entry.id === 'email-send'))
      .toMatchObject({ state: 'unsupported', reason: 'send-replies-disabled-draft-only' });

    const code = await cmdCommsDiagnose(true, {
      runsDir,
      diagnoseEmail: async () => { throw new Error('collector exploded'); },
    });
    expect(code).toBe(1);
    const failed = JSON.parse(logs[1]!);
    expect(failed.email).toMatchObject({ config: 'invalid', polling: 'unknown', sendReplies: 'unknown', outbox: 'not-established', counts: null, replies: 'not-configured', coverage: COVERAGE });
    expect(failed.checks.find((entry: { id: string }) => entry.id === 'email-config'))
      .toMatchObject({ state: 'unavailable', reason: 'email-evidence-unreadable' });
    expect(logs.join('\n')).not.toContain('collector exploded');
  });

  it('exits 0 when every leg including email is healthy', async () => {
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'config.json'),
      JSON.stringify({ comms: { enabled: true, imessageHandle: '+15551234567' } }), { mode: 0o600 });
    const busDir = join(home, '.ashlr', 'fleet', 'bus-inbox');
    mkdirSync(busDir, { recursive: true });
    chmodSync(join(home, '.ashlr', 'fleet'), 0o700);
    chmodSync(busDir, 0o700);
    writeFileSync(join(busDir, 'messages.json'), JSON.stringify({ version: 2, highWater: 0, rows: [] }), { mode: 0o600 });
    mkdirSync(join(home, '.ashlr-runs', 'leader'), { recursive: true });
    writeFileSync(join(home, '.ashlr-runs', 'leader', 'MASON-INBOX.md'), '');
    const emailRuns = join(home, '.ashlr-runs');
    await writeEmailDropConfig(emailRuns, { v: 1, inboxDir, outboxDir, from: [sender], sendReplies: true });
    mkdirSync(outboxDir, { recursive: true });
    expect(await cmdCommsDiagnose(true, { runsDir: emailRuns })).toBe(0);
    const result = JSON.parse(logs[0]!);
    expect(result.checks.every((entry: { state: string }) => entry.state === 'ok' || entry.state === 'unsupported')).toBe(true);
    expect(result.email.replies).toBe('send-enabled');
    expect(errors).toEqual([]);
  });
});
