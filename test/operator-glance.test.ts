import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordEmailToInbox } from '../src/core/comms/email-drop-bridge.js';
import {
  allowOperatorMessage,
  buildOperatorGlance,
  formatOperatorGlance,
  isOperatorStatusAsk,
  resetOperatorRateForTest,
  significantNotice,
} from '../src/core/fleet/operator-glance.js';
import { acceptTelegramPair, readOperatorGlance } from '../src/core/fleet/operator-glance-read.js';
import { dkimPasses, stripPairingSecret } from '../src/core/fleet/operator-proof.js';

const dirs: string[] = [];
afterEach(() => {
  resetOperatorRateForTest();
  delete process.env['PHANTOM_OPERATOR_SECRET'];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('operator glance', () => {
  const now = new Date('2026-11-02T15:00:00.000Z');

  it('answers a plain status ask and treats every other sentence as an order', () => {
    expect(isOperatorStatusAsk("how's the fleet?")).toBe(true);
    expect(isOperatorStatusAsk('status')).toBe(true);
    expect(isOperatorStatusAsk('/status')).toBe(true);
    expect(isOperatorStatusAsk('/fleet-status')).toBe(false);
    expect(isOperatorStatusAsk('hold the claude lane until morning')).toBe(false);
    expect(isOperatorStatusAsk('status the billing rewrite')).toBe(false);
  });

  it('formats one short glance and keeps unknown as unknown', () => {
    const glance = buildOperatorGlance({
      now,
      lanes: [{ running: 4, target: 6, merged24h: 2 }, { running: 1, target: 1, merged24h: 1 }],
      usagePct: 62,
      resetsAt: '2026-11-02T18:00:00.000Z',
      mainText: 'main: green\n',
      incidentText: '- Claude lane is down\n- [x] old outage\n',
      claudeLane: 'down since 04:00',
      switches: ['HOLD'],
    });
    expect(formatOperatorGlance(glance, now.getTime())).toBe([
      'Running 5 of 7.',
      'Usage 62%, resets in 3 h.',
      'Merges 3 today.',
      'Main is healthy.',
      'Incidents: Claude lane is down; HOLD is on.',
    ].join('\n'));
    expect(formatOperatorGlance(buildOperatorGlance({ now }), now.getTime())).toBe([
      'Running unknown.',
      'Usage unknown.',
      'Merges unknown.',
      'Main health unknown.',
    ].join('\n'));
  });

  it('reads main health and incidents from the runs directory and stores orders as text', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'glance-'));
    dirs.push(runsDir);
    mkdirSync(join(runsDir, 'supervisor'));
    mkdirSync(join(runsDir, 'leader'));
    writeFileSync(join(runsDir, 'supervisor', 'status-main.md'), 'main: down\n');
    writeFileSync(join(runsDir, 'leader', 'INCIDENTS.md'), '- Ship needs a human\n');
    const glance = await readOperatorGlance({ runsDir, now: () => now });
    expect(glance.main).toBe('down');
    expect(glance.incidents).toContain('Ship needs a human');
    const order = 'rm -rf / && $(reboot)';
    expect(stripPairingSecret(order, 'not-the-order-text')).toEqual({ presented: false, body: order });
  });

  it('pairs the first Telegram owner and refuses a different id', () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'pair-'));
    dirs.push(runsDir);
    expect(acceptTelegramPair(12345, runsDir)).toBe(true);
    expect(acceptTelegramPair(12345, runsDir)).toBe(true);
    expect(acceptTelegramPair(999, runsDir)).toBe(false);
    expect(readFileSync(join(runsDir, 'queue', 'telegram-pair.json'), 'utf8')).toContain('12345');
  });

  it('requires DKIM for the sender domain and strips the pairing secret from the order', () => {
    expect(dkimPasses('mx.example.com; dkim=pass header.d=example.com', 'mason@example.com')).toBe(true);
    expect(dkimPasses('mx.example.com; dkim=pass header.d=evil.com', 'mason@example.com')).toBe(false);
    expect(dkimPasses('dkim=fail header.d=example.com', 'mason@example.com')).toBe(false);
    const secret = 's'.repeat(24);
    expect(stripPairingSecret(`${secret}\nhold the queue`, secret)).toEqual({ presented: true, body: 'hold the queue' });
  });

  it('sends only a release or a human-only incident', () => {
    expect(significantNotice('fleet-merged', 'weekly release')).toBe('Release shipped.');
    expect(significantNotice('fleet-merged', 'fix a typo')).toBeNull();
    expect(significantNotice('fleet-lane-held', 'codex-personal: usage_limit')).toBeNull();
    expect(significantNotice('fleet-lane-held', 'claude: down')).toBe('Claude lane is down. It needs you.');
    expect(significantNotice('needs-you', '')).toBe('Needs you.');
    expect(significantNotice('completed', 'done')).toBeNull();
  });

  it('stops accepting after the rate limit', () => {
    for (let i = 0; i < 500; i += 1) expect(allowOperatorMessage('email:mason@example.com', 1_000)).toBe(true);
    expect(allowOperatorMessage('email:mason@example.com', 1_000)).toBe(false);
  });

  it('records a DKIM-paired email order and does not keep the secret', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mail-'));
    dirs.push(root);
    const runsDir = join(root, 'runs');
    const outboxDir = join(root, 'out');
    mkdirSync(runsDir);
    const secret = 'p'.repeat(24);
    process.env['PHANTOM_OPERATOR_SECRET'] = secret;
    const raw = [
      'From: Mason <mason@example.com>',
      'Subject: queue',
      'Message-ID: <order-1@example.com>',
      'Authentication-Results: mx.example.com; dkim=pass header.d=example.com',
      '',
      secret,
      'hold the claude lane until morning',
      '',
    ].join('\r\n');
    const result = await recordEmailToInbox(raw, {
      allowedSenders: new Set(['mason@example.com']),
      runsDir,
      outboxDir,
      now: () => now,
    });
    expect(result.ok).toBe(true);
    const inbox = readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8');
    expect(inbox).toContain('hold the claude lane until morning');
    expect(inbox).not.toContain(secret);
    const refused = await recordEmailToInbox(raw.replace('dkim=pass header.d=example.com', 'dkim=fail header.d=example.com'), {
      allowedSenders: new Set(['mason@example.com']),
      runsDir,
      outboxDir,
      now: () => now,
    });
    expect(refused).toEqual({ ok: false, reason: 'sender-not-allowed' });
  });
});
