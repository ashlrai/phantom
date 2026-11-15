import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetCommsReadiness } from '../src/cli/fleet-comms-readiness.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import type { CommsCutoverReadinessDeps, IMessagePathReport } from '../src/core/comms/cutover-readiness.js';
import type { EmailDiagnosis } from '../src/core/comms/email-diagnosis.js';

let root: string, runsDir: string, logs: string[], errors: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'comms-readiness-'));
  runsDir = join(root, 'runs');
  logs = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

const NEXT_STEPS = new Set(['phm comms setup-email', 'phm fleet email-outbox --json',
  'phm imessage doctor --json', 'phm imessage poll --json', 'phm comms diagnose --json', 'phm fleet gmail-triage']);
const PRIVATE_MARKERS = ['fake-private-address@example.test', 'fake-private-handle', '/fake/secret/path',
  'fake-secret-exception', 'fake body text'];

const emailDiag = (over: Partial<EmailDiagnosis> = {}): EmailDiagnosis => ({
  config: 'ok', polling: 'enabled', sendReplies: 'enabled', outbox: 'ok',
  counts: { queued: 0, drafted: 0, sent: 1, stuck: 0 }, replies: 'send-enabled',
  coverage: 'local-evidence-only-not-gmail-triage-or-proof-of-delivery', checks: [], ...over,
});
const finding = (state: string, reason: string) =>
  ({ state, reason, nextStep: 'phm imessage doctor --json' });
const imsgReport = (over: Partial<IMessagePathReport> = {}): IMessagePathReport => ({
  schema: 'fleet.imessage-path.v1',
  platform: finding('supported', 'MACOS'),
  configuration: finding('configured', 'CONFIG_ENABLED'),
  chatDb: finding('readable', 'DB_READABLE'),
  cursor: finding('present', 'CURSOR_BASELINE_PRESENT'),
  transport: finding('owner_only', 'SELF_ONLY_TRANSPORT'),
  ownerReply: finding('unknown', 'OWNER_DELIVERY_NOT_VERIFIED'),
  collaboratorIntake: finding('unsupported', 'VERIFIED_OWNER_ONLY'),
  collaboratorDelivery: finding('unsupported', 'SELF_ONLY_TRANSPORT'),
  ...over,
});
const healthy = (emailOver: Partial<EmailDiagnosis> = {}, imsgOver: Partial<IMessagePathReport> = {}): CommsCutoverReadinessDeps => ({
  runsDir,
  diagnoseEmail: async () => emailDiag(emailOver),
  checkIMessage: () => imsgReport(imsgOver),
});
const report = async (deps: CommsCutoverReadinessDeps) => {
  const code = await cmdFleetCommsReadiness(['--json'], deps);
  return { code, parsed: JSON.parse(logs.at(-1)!) };
};
const noLeaks = () => {
  const out = logs.join('\n') + errors.join('\n');
  for (const marker of [...PRIVATE_MARKERS, root]) expect(out).not.toContain(marker);
};

describe('fleet comms-readiness', () => {
  it('maps healthy local email plus unverified iMessage to an incomplete cutover', async () => {
    const { code, parsed } = await report(healthy());
    expect(code).toBe(0);
    expect(parsed.schema).toBe('fleet.comms-cutover-readiness.v1');
    const c = parsed.capabilities;
    expect(c.emailPolling.state).toBe('ready');
    expect(c.emailOutbox.state).toBe('ready');
    expect(c.ownerImessageIntake.state).toBe('ready');
    expect(c.ownerImessageDelivery).toMatchObject({ state: 'unverified', reason: 'OWNER_DELIVERY_NOT_VERIFIED' });
    expect(c.teammateImessageIntake.state).toBe('unsupported');
    expect(c.teammateImessageDelivery.state).toBe('unsupported');
    expect(c.gmailInboxTriage.state).toBe('unverified');
    expect(c.linkedin.state).toBe('unverified');
    expect(parsed.overall.state).toBe('incomplete');
    expect(parsed.overall.commsbotRetirement).toBe('not-evidenced');
    expect(parsed.overall.blockers).not.toContain('emailPolling');
    for (const cap of Object.values(parsed.capabilities)) {
      expect(NEXT_STEPS).toContain((cap as { nextStep: string }).nextStep);
    }
    noLeaks();
  });

  it('blocks email legs on missing config and an unreadable outbox', async () => {
    const missing = await report(healthy({
      config: 'missing', polling: 'unknown', sendReplies: 'unknown',
      outbox: 'not-established', counts: null, replies: 'not-configured',
    }));
    expect(missing.parsed.capabilities.emailPolling)
      .toMatchObject({ state: 'blocked', reason: 'email-config-missing', nextStep: 'phm comms setup-email' });
    expect(missing.parsed.capabilities.emailOutbox.state).toBe('blocked');
    expect(missing.parsed.overall.state).toBe('incomplete');

    const unreadable = await report(healthy({ outbox: 'unreadable', counts: null, replies: 'blocked' }));
    expect(unreadable.parsed.capabilities.emailOutbox)
      .toMatchObject({ state: 'blocked', reason: 'email-outbox-unreadable', nextStep: 'phm comms setup-email' });
    noLeaks();
  });

  it('treats deliberate draft-only as ready local evidence, never a send suggestion', async () => {
    const { parsed } = await report(healthy({
      sendReplies: 'disabled', replies: 'draft-only', counts: { queued: 2, drafted: 0, sent: 0, stuck: 0 },
    }));
    expect(parsed.capabilities.emailOutbox)
      .toMatchObject({ state: 'ready', reason: 'email-outbox-readable-draft-only', nextStep: 'phm fleet email-outbox --json' });
    expect(logs.join('\n')).not.toContain('--send');
    noLeaks();
  });

  it('reports unsupported platform and unsupported teammate delivery without inflation', async () => {
    const { parsed } = await report(healthy({}, {
      platform: finding('unsupported', 'PLATFORM_UNSUPPORTED'), chatDb: finding('unknown', 'DB_NOT_PROBED'),
    }));
    expect(parsed.capabilities.ownerImessageIntake)
      .toMatchObject({ state: 'unsupported', reason: 'PLATFORM_UNSUPPORTED' });
    expect(parsed.capabilities.teammateImessageDelivery)
      .toMatchObject({ state: 'unsupported', reason: 'SELF_ONLY_TRANSPORT' });
    expect(parsed.overall.state).toBe('incomplete');

    // Even an injected teammate 'ready' is capped at unverified, never claimed.
    const inflated = await report(healthy({}, {
      collaboratorIntake: finding('ready', 'VERIFIED_OWNER_ONLY'),
      collaboratorDelivery: finding('ready', 'SELF_ONLY_TRANSPORT'),
    }));
    expect(inflated.parsed.capabilities.teammateImessageIntake.state).toBe('unverified');
    expect(inflated.parsed.capabilities.teammateImessageDelivery.state).toBe('unverified');
    noLeaks();
  });

  it('degrades reader rejection to unverified with fixed codes only', async () => {
    const { code, parsed } = await report({
      runsDir,
      diagnoseEmail: async () => { throw new Error('fake-secret-exception at /fake/secret/path'); },
      checkIMessage: () => { throw new Error('fake-secret-exception'); },
    });
    expect(code).toBe(0);
    expect(parsed.capabilities.emailPolling).toMatchObject({ state: 'unverified', reason: 'email-reader-unavailable' });
    expect(parsed.capabilities.ownerImessageIntake).toMatchObject({ state: 'unverified', reason: 'imessage-reader-unavailable' });
    expect(parsed.capabilities.teammateImessageDelivery.state).toBe('unverified');
    expect(parsed.overall.state).toBe('incomplete');
    noLeaks();
  });

  it('never leaks injected reason text, addresses or paths', async () => {
    const { parsed } = await report(healthy(
      { outbox: '/fake/secret/path' as unknown as EmailDiagnosis['outbox'] },
      {
        configuration: finding('configured', 'fake-private-address@example.test'),
        ownerReply: finding('unknown', 'fake body text'),
        collaboratorDelivery: finding('unsupported', '/fake/secret/path'),
      },
    ));
    expect(parsed.capabilities.ownerImessageDelivery.reason).toBe('EVIDENCE_UNRECOGNIZED');
    expect(parsed.capabilities.teammateImessageDelivery.reason).toBe('EVIDENCE_UNRECOGNIZED');
    expect(parsed.capabilities.emailOutbox.reason).toBe('email-outbox-unavailable');
    noLeaks();
  });

  it('runs the real email reader against a temporary runs dir', async () => {
    // diagnoseEmailDrop is not injected: an empty temp runs dir reads as
    // missing config, and missing Gmail/LinkedIn evidence stays unverified.
    const { code, parsed } = await report({ runsDir, checkIMessage: () => imsgReport() });
    expect(code).toBe(0);
    expect(parsed.capabilities.emailPolling.reason).toBe('email-config-missing');
    expect(parsed.capabilities.gmailInboxTriage.state).toBe('unverified');
    expect(parsed.capabilities.linkedin.state).toBe('unverified');
    expect(parsed.overall.state).toBe('incomplete');
    noLeaks();
  });

  it('prints a concise blocker list in text mode', async () => {
    expect(await cmdFleetCommsReadiness([], healthy())).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('comms-cutover: incomplete');
    expect(out).toContain('ownerImessageDelivery: unverified (OWNER_DELIVERY_NOT_VERIFIED)');
    expect(out).toContain('teammateImessageDelivery: unsupported (SELF_ONLY_TRANSPORT)');
    expect(out).toContain('gmailInboxTriage: unverified');
    expect(out).not.toContain('emailPolling:');
    noLeaks();
  });

  it('prints help without any filesystem read and rejects unknown args', async () => {
    const diagnoseEmail = vi.fn(), checkIMessage = vi.fn();
    const deps = { runsDir, diagnoseEmail, checkIMessage };
    expect(await cmdFleetCommsReadiness(['--help'], deps)).toBe(0);
    expect(await cmdFleetCommsReadiness(['-h'], deps)).toBe(0);
    expect(diagnoseEmail).not.toHaveBeenCalled();
    expect(checkIMessage).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('Usage: ashlr fleet comms-readiness');

    for (const args of [['--bogus'], ['extra'], ['--json', '--json'], ['--json', 'x']]) {
      expect(await cmdFleetCommsReadiness(args, healthy())).toBe(2);
      expect(errors.at(-1)).toContain('Usage:');
    }
    noLeaks();
  });

  it('exposes the convention discovery surface', () => {
    const resolved = resolveFleetSubcommand('comms-readiness');
    expect(resolved?.module).toBe('./fleet-comms-readiness.js');
    expect(resolved?.exportName).toBe('cmdFleetCommsReadiness');
  });
});
