import { rememberEmailPair } from '../src/core/fleet/operator-glance-read.js';
/**
 * RQ-PHX-COMMSSTATUSPATH101 — integration qualification of the email status
 * round trip through the real drop-folder bridge.
 *
 * Module under test: src/core/comms/email-drop-bridge.ts (the exported pass
 * entry, runEmailDropOnce) wired the way `phm comms email-cycle` wires it: a
 * saved email-drop.json config names the inbox/outbox/processed folders and
 * the From allowlist, a raw `.eml` lands in the inbox, and the outbound leg is
 * sendEmailOutbox. Only the two designed seams are substituted — the local
 * fleet readers (`statusReaders`) and the mail transport — so intake, sender
 * verification, replay journaling, response construction and the outbox claim
 * protocol all run for real.
 *
 * Hermetic: HOME, runsDir, busRoot, drop folders, drafts and the transport are
 * all tmp fixtures; the clock is fixed; no network, no credentials, no Mail.app.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEmailDropOnce, type EmailDropCounts } from '../src/core/comms/email-drop-bridge.js';
import { readEmailDropConfig, writeEmailDropConfig, type EmailDropConfig } from '../src/core/comms/email-drop-config.js';
import { sendEmailOutbox, type EmailTransport } from '../src/core/comms/email-outbox.js';
import { listDrafts } from '../src/core/cos/drafts.js';
import { resetOperatorRateForTest } from '../src/core/fleet/operator-glance.js';
import type { EmailFleetStatusReaders } from '../src/core/comms/email-fleet-status.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { StatusSupply } from '../src/core/comms/status-supply-line.js';

const MASON = 'mason@example.com';
const FIXED = new Date('2026-11-10T17:00:00.000Z');
const now = () => FIXED;

let root = '';
let home = '';
let runsDir = '';
let busRoot = '';
let inboxDir = '';
let outboxDir = '';
let processedDir = '';
let allowedSenders = new Set<string>();
let previousHome: string | undefined;

/** Recording transport: the send leg stays real, only the wire is fake. */
const transport = vi.fn<EmailTransport>(async () => ({ ok: true }));

function eml(over: { from?: string; id?: string | null; subject?: string; body?: string; dkim?: string } = {}): string {
  const {
    from = `Mason Wyatt <${MASON}>`,
    id = '<status-101-a@example.com>',
    subject = 'status request',
    body = '/fleet-status',
    dkim = 'Authentication-Results: mx.example.com; dkim=pass header.d=example.com',
  } = over;
  return [
    `From: ${from}`,
    `To: phantom@example.com`,
    `Subject: ${subject}`,
    ...(id === null ? [] : [`Message-ID: ${id}`]),
    'Date: Tue, 10 Nov 2026 11:00:00 -0500',
    dkim,
    '',
    body,
    '',
  ].join('\r\n');
}

const drop = (name: string, raw: string): void => writeFileSync(join(inboxDir, name), raw, 'utf8');
const outboxReplies = (): string[] =>
  existsSync(outboxDir) ? readdirSync(outboxDir).filter((name) => name.endsWith('.reply.eml')).sort() : [];
const replyFileName = (messageId: string): string =>
  `status-${createHash('sha256').update(messageId).digest('hex')}.reply.eml`;
const claimFile = (messageId: string): string =>
  join(runsDir, 'queue', 'email-status-seen', createHash('sha256').update(messageId).digest('hex'));
const inboxPath = (): string => join(runsDir, 'leader', 'MASON-INBOX.md');
const replyBody = (name: string): string => readFileSync(join(outboxDir, name), 'utf8');

/** The same wiring cmdEmailCycle performs: saved config → one drop pass. */
async function runPass(statusReaders?: EmailFleetStatusReaders, ownerStatusComposer?: (runsDir: string, now: Date) => Promise<string>): Promise<EmailDropCounts> {
  const saved = await readEmailDropConfig(runsDir);
  if (saved.state !== 'ok' || !saved.config) throw new Error(`config not ok: ${saved.state}`);
  const config: EmailDropConfig = saved.config;
  return runEmailDropOnce({
    inboxDir: config.inboxDir,
    outboxDir: config.outboxDir!,
    processedDir: config.processedDir!,
    allowedSenders: new Set(config.from),
    runsDir,
    busRoot,
    now,
    ...(statusReaders ? { statusReaders } : {}),
    ...(ownerStatusComposer ? { ownerStatusComposer } : {}),
  });
}

const sendPass = () =>
  sendEmailOutbox({ dir: outboxDir, allowedRecipients: allowedSenders, transport, draftsRunsDir: runsDir, now });

function healthyRuns(over: Partial<FleetRunsDirState> = {}): FleetRunsDirState {
  return {
    v: 1, generatedAt: FIXED.toISOString(), runsDirPresent: true, sourceState: 'healthy',
    sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
    lastTick: '2026-11-10T16:59:00.000Z', paused: false, memFreePct: 40, diskFreeGb: 100,
    lanes: [
      { lane: 'devin', running: 2, target: 3, floor: null, ceiling: null, queued: 1, held: true, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null },
      { lane: 'claude', running: 3, target: 5, floor: null, ceiling: null, queued: 1, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null },
    ],
    switches: [], claudeLane: null, publishesLastHour: [], events: [], claimed: [],
    drop: { pending: [], done: 0 },
    ...over,
  };
}

function healthyWorkers(over: Partial<LiveWorkersSnapshot> = {}): LiveWorkersSnapshot {
  return {
    v: 1, generatedAt: FIXED.toISOString(), sourceState: 'healthy',
    workers: [
      { pid: 101, job: 'job-a', repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 30 },
      { pid: 102, job: 'job-b', repo: 'phantom', lane: 'claude', tier: 'work', ageSeconds: 40 },
    ],
    leaders: [{ pid: 99, label: 'leader-pass', ageSeconds: 10 }],
    orchestratorAgents: 3,
    ...over,
  };
}

function healthySupply(over: Partial<StatusSupply> = {}): StatusSupply {
  return {
    v: 1, sourceState: 'healthy',
    lanes: [{ lane: 'devin', phxReady: 2, fillerReady: 1 }],
    planner: { status: 'ok', lastGoodPassAt: '2026-11-10T16:00:00.000Z', reason: null, failingSince: null },
    ...over,
  };
}

beforeEach(async () => {
  previousHome = process.env['HOME'];
  root = mkdtempSync(join(tmpdir(), 'comms-status-101-'));
  home = join(root, 'home');
  runsDir = join(root, 'runs');
  busRoot = join(root, 'bus');
  inboxDir = join(root, 'mail', 'inbox');
  outboxDir = join(root, 'mail', 'outbox');
  processedDir = join(root, 'mail', 'processed');
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['HOME'] = home;
  allowedSenders = new Set([MASON]);
  transport.mockClear();
  resetOperatorRateForTest();
  rememberEmailPair(MASON, runsDir);
  await writeEmailDropConfig(runsDir, { v: 1, inboxDir, outboxDir, processedDir, from: [MASON] });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe('email status path through the configured drop', () => {
  it('/fleet-status earns one correlated durable reply; reprocessing produces no second answer', async () => {
    const readers: EmailFleetStatusReaders = {
      runs: vi.fn(async () => healthyRuns()),
      workers: vi.fn(async () => healthyWorkers()),
      supply: vi.fn(async () => healthySupply()),
    };
    const id = 'status-101-a@example.com';
    drop('01-status.eml', eml({ id: `<${id}>` }));

    expect(await runPass(readers)).toEqual({ accepted: 1, duplicate: 0, refused: 0, failed: 0, status: { queued: 1, duplicate: 0 } });

    // The durable answer: one reply .eml correlated to the request Message-ID.
    expect(outboxReplies()).toEqual([replyFileName(id)]);
    const reply = replyBody(replyFileName(id));
    expect(reply).toContain(`To: ${MASON}\r\n`);
    expect(reply).toContain('Subject: Re: Phantom fleet status\r\n');
    expect(reply).toContain(`In-Reply-To: <${id}>\r\n`);
    expect(reply).toContain(`References: <${id}>\r\n`);
    expect(reply).toContain(`Phantom fleet status (${FIXED.toISOString()})`);
    expect(reply).toContain('Runs status: available; paused: no');
    expect(reply).toContain('running: 5');
    expect(reply).toContain('target: 8');
    expect(reply).toContain('queued: 2');
    expect(reply).toContain('held lanes: 1');
    expect(reply).toContain('Live workers: 2');
    expect(reply).toContain('Leader passes: 1');
    expect(reply).toContain('Orchestrator agents: 3');
    expect(reply).toContain('Supply: devin 2 phantom / 1 filler');
    expect(reply).toContain('Planner: last good pass 2026-11-10T16:00:00.000Z');
    // A status reply is not an inbox receipt: no journal write, no preview echo.
    expect(reply).not.toContain('Inbox:');
    expect(existsSync(inboxPath())).toBe(false);
    // Durable evidence: the request moved to processed and the reply claim persists.
    expect(readdirSync(processedDir)).toEqual(['01-status.eml']);
    expect(existsSync(claimFile(id))).toBe(true);

    // The outbound leg: the queued reply goes to the operator via the injected transport.
    const send = await sendPass();
    expect(send.sent).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toMatchObject({ to: MASON, subject: 'Re: Phantom fleet status' });
    expect(transport.mock.calls[0]![0].body).toContain('Phantom fleet status');
    expect(outboxReplies()).toEqual([]);
    expect(existsSync(join(outboxDir, 'sent', replyFileName(id)))).toBe(true);

    // Redelivery of the same Message-ID: the permanent claim suppresses a
    // second answer and the readers are not consulted again.
    drop('02-status.eml', eml({ id: `<${id}>` }));
    expect(await runPass(readers)).toEqual({ accepted: 0, duplicate: 1, refused: 0, failed: 0, status: { queued: 0, duplicate: 1 } });
    expect(readdirSync(processedDir).sort()).toEqual(['01-status.eml', '02-status.eml']);
    expect(outboxReplies()).toEqual([]);
    expect(readers.runs).toHaveBeenCalledTimes(1);
    expect(readers.workers).toHaveBeenCalledTimes(1);
    expect(readers.supply).toHaveBeenCalledTimes(1);
    expect((await sendPass()).sent).toBe(0);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('a failed fleet reader reports unavailable while the measured counts stay useful', async () => {
    const readers: EmailFleetStatusReaders = {
      runs: vi.fn(async () => { throw new Error('reader diag /private/reader-root exploded'); }),
      workers: vi.fn(async () => healthyWorkers({ orchestratorAgents: 0 })),
      supply: vi.fn(async () => healthySupply({ lanes: [{ lane: 'claude', phxReady: 1, fillerReady: 2 }] })),
    };
    const id = 'status-101-b@example.com';
    drop('status.eml', eml({ id: `<${id}>` }));

    expect(await runPass(readers)).toMatchObject({ accepted: 1, status: { queued: 1 } });
    const reply = replyBody(replyFileName(id));
    expect(reply).toContain('Runs status: unavailable');
    expect(reply).toContain('Live workers: 2');
    expect(reply).toContain('Leader passes: 1');
    expect(reply).toContain('Orchestrator agents: 0');
    expect(reply).toContain('Supply: claude 1 phantom / 2 filler');
    expect(reply).toContain('Planner: last good pass 2026-11-10T16:00:00.000Z');
    // Raw reader diagnostics and paths never reach the email.
    for (const leak of ['reader-root', 'exploded', 'diag', '/private', root]) {
      expect(reply).not.toContain(leak);
    }
    expect((await sendPass()).sent).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('reader payloads stay counts-only: identifiers, paths and free text never leak', async () => {
    const state = healthyRuns();
    state.lanes = [
      { lane: 'secret-lane-name', running: 2, target: 3, floor: null, ceiling: null, queued: 1, held: true, heldReason: '/private/hold reason', tokensLastHour: null, merged24h: null, mergeRate24h: null },
    ];
    state.events = [{ at: '2026-11-10T16:00:00.000Z', kind: 'INCIDENT', text: '/private/raw-log-secret' }];
    const snapshot = healthyWorkers();
    snapshot.workers = [{ pid: 7, job: 'private-job-handle', repo: 'private-repo', lane: 'secret-lane-name', tier: 'work', ageSeconds: 5 }];
    const readers: EmailFleetStatusReaders = {
      runs: vi.fn(async () => state),
      workers: vi.fn(async () => snapshot),
      // A lane outside the shared allowlist is dropped, not echoed.
      supply: vi.fn(async () => healthySupply({ lanes: [{ lane: 'rogue-lane-xyz', phxReady: 7, fillerReady: 7 }] })),
    };
    const id = 'status-101-c@example.com';
    drop('status.eml', eml({ id: `<${id}>`, subject: 'please report /private/operator-note' }));

    expect(await runPass(readers)).toMatchObject({ accepted: 1, status: { queued: 1 } });
    const reply = replyBody(replyFileName(id));
    expect(reply).toContain('running: 2');
    expect(reply).toContain('held lanes: 1');
    expect(reply).toContain('Live workers: 1');
    expect(reply).toContain('Supply: none ready');
    expect(reply).not.toMatch(/secret|private|raw-log|rogue|operator-note|Inbox:/i);
    expect(reply).not.toContain(root);
  });

  it('plain-language "Phantom status" asks land in the inbox and earn the digest reply', async () => {
    // Natural-language asks ride the ordinary receiver now: the mail is
    // journaled like any order and the same-thread reply carries the owner
    // status digest, so the /fleet-status readers are never consulted.
    const readers: EmailFleetStatusReaders = {
      runs: vi.fn(async () => healthyRuns()),
      workers: vi.fn(async () => healthyWorkers()),
      supply: vi.fn(async () => healthySupply()),
    };
    const digest = 'Phantom status, 17:00 ET\nShipped (last 12h): none\nNeeds you: none';
    drop('a.eml', eml({ id: '<ask-101-a@example.com>', body: 'status' }));
    drop('b.eml', eml({ id: '<ask-101-b@example.com>', body: 'fleet status' }));

    expect(await runPass(readers, async () => digest)).toEqual({ accepted: 2, duplicate: 0, refused: 0, failed: 0 });
    const askReplyName = (id: string) => `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.reply.eml`;
    expect(outboxReplies()).toEqual([askReplyName('ask-101-a@example.com'), askReplyName('ask-101-b@example.com')].sort());
    for (const [file, id] of [[askReplyName('ask-101-a@example.com'), 'ask-101-a@example.com'], [askReplyName('ask-101-b@example.com'), 'ask-101-b@example.com']] as const) {
      const reply = replyBody(file);
      expect(reply).toContain(`To: ${MASON}\r\n`);
      expect(reply).toContain('Subject: Re: status request\r\n');
      expect(reply).toContain(`In-Reply-To: <${id}>\r\n`);
      expect(reply).toContain(`References: <${id}>\r\n`);
      expect(reply).toContain(digest);
      // Neither the generic ack receipt nor the retired glance leaks.
      expect(reply).not.toContain('Received by Phantom');
      expect(reply).not.toContain('Running unknown.');
      expect(reply).not.toContain('Inbox:');
      expect(reply).not.toContain(root);
    }
    // The ask is a journaled order: the inbox entry exists and the status
    // readers were never consulted.
    expect(readers.runs).not.toHaveBeenCalled();
    expect(readers.workers).not.toHaveBeenCalled();
    expect(readers.supply).not.toHaveBeenCalled();
    const inbox = readFileSync(inboxPath(), 'utf8');
    expect(inbox).toContain('status');
    expect(inbox).toContain('fleet status');
    expect((await sendPass()).sent).toBe(2);
  });

  it('outside senders keep the existing gate: refused quietly, nothing leaves the machine', async () => {
    const readers: EmailFleetStatusReaders = {
      runs: vi.fn(async () => healthyRuns()),
      workers: vi.fn(async () => healthyWorkers()),
      supply: vi.fn(async () => healthySupply()),
    };
    // Not on the From allowlist; forged authentication evidence is ignored.
    drop('outsider.eml', eml({
      from: 'Intruder <intruder@example.net>', id: '<outsider-101@example.net>',
      dkim: 'Authentication-Results: mx.example.net; dkim=pass header.d=example.net',
    }));
    // On the allowlist but never paired and failing DKIM: still refused.
    drop('spoofed.eml', eml({
      id: '<spoofed-101@example.com>',
      dkim: 'Authentication-Results: mx.example.com; dkim=fail header.d=example.com',
    }));

    expect(await runPass(readers)).toEqual({ accepted: 0, duplicate: 0, refused: 2, failed: 0 });
    expect(outboxReplies()).toEqual([]);
    expect(existsSync(inboxPath())).toBe(false);
    expect(readdirSync(processedDir).sort()).toEqual(['outsider.eml', 'spoofed.eml']);
    expect(readers.runs).not.toHaveBeenCalled();
    expect(readers.workers).not.toHaveBeenCalled();
    expect(readers.supply).not.toHaveBeenCalled();

    // The outbound side keeps its contract too: a reply addressed to someone
    // outside the allowlist becomes a pending draft, never a send.
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(join(outboxDir, 'planted.reply.eml'),
      'To: third-party@example.net\r\nSubject: Re: Phantom\r\nContent-Type: text/plain\r\n\r\nstatus words\r\n', 'utf8');
    const send = await sendPass();
    expect(send.drafted).toBe(1);
    expect(send.sent).toBe(0);
    expect(transport).not.toHaveBeenCalled();
    expect(existsSync(join(outboxDir, 'drafted', 'planted.reply.eml'))).toBe(true);
    const drafts = await listDrafts({ runsDir, status: 'pending' });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ to: 'third-party@example.net', channel: 'email', status: 'pending' });
  });
});
