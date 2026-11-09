/**
 * RQ-PHX-COMMSCUTOVER05SRB1 — the `ashlr fleet comms-readiness` report.
 *
 * Before Commsbot is retired an agent must be able to answer "which parts of
 * the email/iMessage cutover are ready?" from local evidence alone. This
 * module folds the two established readers — diagnoseEmailDrop and
 * checkIMessagePath — into one versioned per-capability report, and marks the
 * capabilities no local reader can evidence (LinkedIn)
 * explicitly unverified. Saved config is never proof of delivery, so overall
 * cutover stays incomplete while any capability is not ready and this report
 * can never claim Commsbot is retirable.
 *
 * Projections only: fixed states, reason codes and next-step commands leave
 * this module — never paths, addresses, bodies or exception text. Reader
 * failures degrade to 'unverified', never to 'ready'. Nothing here sends
 * mail, probes Messages or toggles a gate; deliberate draft-only send posture
 * is never reported as a blocker.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readGmailTriageLatest } from './gmail-triage-latest.js';
import { readGmailArchivePlanLatest } from './gmail-archive-plan-latest.js';
import { diagnoseEmailDrop, type EmailDiagnosis } from './email-diagnosis.js';
import { checkIMessagePath, type IMessagePathDeps } from './imessage-path-check.js';

export const CUTOVER_READINESS_SCHEMA = 'fleet.comms-cutover-readiness.v1';
export type CutoverState = 'ready' | 'blocked' | 'unsupported' | 'unverified';
export interface CutoverCapability {
  state: CutoverState;
  reason: string;
  nextStep: string;
  /** Observed outbox counts when the reader produced them; numbers only. */
  counts?: EmailDiagnosis['counts'];
}
export type IMessagePathReport = ReturnType<typeof checkIMessagePath>;
type Finding = IMessagePathReport['platform'];

export interface CommsCutoverCapabilities {
  emailPolling: CutoverCapability;
  emailOutbox: CutoverCapability;
  ownerImessageIntake: CutoverCapability;
  ownerImessageDelivery: CutoverCapability;
  teammateImessageIntake: CutoverCapability;
  teammateImessageDelivery: CutoverCapability;
  gmailInboxTriage: CutoverCapability;
  linkedin: CutoverCapability;
}

export interface CommsCutoverReport {
  schema: typeof CUTOVER_READINESS_SCHEMA;
  coverage: 'local-evidence-only-not-delivery-proof';
  capabilities: CommsCutoverCapabilities;
  overall: {
    state: 'complete' | 'incomplete';
    /** Capability ids that are not 'ready'. */
    blockers: string[];
    /** Always 'not-evidenced': local evidence can never retire Commsbot. */
    commsbotRetirement: 'not-evidenced';
    nextStep: string;
  };
}

export interface CommsCutoverReadinessDeps {
  /** Local-evidence runs root; default ASHLR_RUNS_DIR ?? ~/.ashlr-runs (test seam). */
  runsDir?: string;
  /** Email evidence reader; default diagnoseEmailDrop (test seam). */
  diagnoseEmail?: (runsDir: string) => Promise<EmailDiagnosis>;
  /** iMessage path reader; default checkIMessagePath (test seam). */
  checkIMessage?: (deps: IMessagePathDeps) => IMessagePathReport;
  readGmailTriage?: typeof readGmailTriageLatest;
  readGmailPlans?: typeof readGmailArchivePlanLatest;
  now?: () => number;
  /** Extra deps forwarded to the iMessage path reader (test seam). */
  imessage?: IMessagePathDeps;
}

const NEXT_SETUP_EMAIL = 'phm comms setup-email';
const NEXT_OUTBOX = 'phm fleet email-outbox --json';
const NEXT_IMSG_DOCTOR = 'phm imessage doctor --json';
const NEXT_IMSG_POLL = 'phm imessage poll --json';
const NEXT_DIAGNOSE = 'phm comms diagnose --json';

// The reason codes the established iMessage reader can emit; anything else is
// folded to a fixed fallback so injected reader text can never leak.
const IMESSAGE_REASONS: ReadonlySet<string> = new Set([
  'MACOS', 'PLATFORM_UNSUPPORTED', 'CONFIG_UNAVAILABLE', 'CONFIG_ENABLED', 'CONFIG_DISABLED_OR_INCOMPLETE',
  'DB_NOT_PROBED', 'DB_READABLE', 'DB_ACCESS_BLOCKED', 'DB_MISSING_OR_UNREADABLE', 'DB_PROBE_UNAVAILABLE',
  'CURSOR_BASELINE_PRESENT', 'CURSOR_UNAVAILABLE', 'SELF_ONLY_TRANSPORT', 'OWNER_DELIVERY_NOT_VERIFIED', 'VERIFIED_OWNER_ONLY',
]);
const imsgReason = (finding: Finding | undefined): string =>
  finding && IMESSAGE_REASONS.has(finding.reason) ? finding.reason : 'EVIDENCE_UNRECOGNIZED';

const OUTBOX_BLOCKERS: ReadonlySet<string> = new Set(['missing', 'not-directory', 'unreadable']);
const unavailable = (reason: string): CutoverCapability => ({ state: 'unverified', reason, nextStep: NEXT_DIAGNOSE });

function emailPolling(d: EmailDiagnosis | null): CutoverCapability {
  if (!d) return unavailable('email-reader-unavailable');
  if (d.config === 'missing' || d.config === 'invalid')
    return { state: 'blocked', reason: `email-config-${d.config}`, nextStep: NEXT_SETUP_EMAIL };
  if (d.config !== 'ok') return { state: 'unverified', reason: 'email-config-unrecognized', nextStep: NEXT_SETUP_EMAIL };
  if (d.polling === 'paused') return { state: 'blocked', reason: 'email-polling-paused', nextStep: NEXT_SETUP_EMAIL };
  return d.polling === 'enabled'
    ? { state: 'ready', reason: 'email-polling-enabled', nextStep: NEXT_DIAGNOSE }
    : unavailable('email-polling-unknown');
}

function emailOutbox(d: EmailDiagnosis | null): CutoverCapability {
  if (!d) return unavailable('email-reader-unavailable');
  if (d.outbox === 'not-established')
    return { state: 'blocked', reason: 'email-outbox-not-established', nextStep: NEXT_SETUP_EMAIL };
  if (d.outbox !== 'ok') {
    return { state: 'blocked', nextStep: NEXT_SETUP_EMAIL,
      reason: OUTBOX_BLOCKERS.has(d.outbox) ? `email-outbox-${d.outbox}` : 'email-outbox-unavailable' };
  }
  if ((d.counts?.stuck ?? 0) > 0)
    return { state: 'blocked', reason: 'email-outbox-stuck-replies', nextStep: NEXT_OUTBOX, counts: d.counts };
  // Draft-only is deliberate, never a blocker; nothing recommends enabling sends.
  const reason = d.replies === 'draft-only' ? 'email-outbox-readable-draft-only'
    : d.replies === 'send-enabled' ? 'email-outbox-readable' : 'email-outbox-readable-send-unverified';
  return { state: 'ready', reason, nextStep: NEXT_OUTBOX, counts: d.counts };
}

function ownerImessageIntake(r: IMessagePathReport | null): CutoverCapability {
  if (!r) return unavailable('imessage-reader-unavailable');
  if (r.platform?.state === 'unsupported')
    return { state: 'unsupported', reason: imsgReason(r.platform), nextStep: NEXT_IMSG_DOCTOR };
  if (r.platform?.state !== 'supported')
    return { state: 'unverified', reason: imsgReason(r.platform), nextStep: NEXT_IMSG_DOCTOR };
  if (r.configuration?.state === 'disabled')
    return { state: 'blocked', reason: imsgReason(r.configuration), nextStep: NEXT_IMSG_DOCTOR };
  if (r.configuration?.state !== 'configured')
    return { state: 'unverified', reason: imsgReason(r.configuration), nextStep: NEXT_IMSG_DOCTOR };
  if (r.chatDb?.state === 'unavailable' && r.chatDb.reason !== 'DB_PROBE_UNAVAILABLE')
    return { state: 'blocked', reason: imsgReason(r.chatDb), nextStep: NEXT_IMSG_DOCTOR };
  if (r.chatDb?.state !== 'readable')
    return { state: 'unverified', reason: imsgReason(r.chatDb), nextStep: NEXT_IMSG_DOCTOR };
  if (r.cursor?.state !== 'present')
    return { state: 'unverified', reason: imsgReason(r.cursor), nextStep: NEXT_IMSG_POLL };
  return { state: 'ready', reason: 'imessage-intake-evidence-present', nextStep: NEXT_IMSG_POLL };
}

// The established reader always reports owner delivery unverified and no
// local evidence can prove it; this leg can never read 'ready'.
function ownerImessageDelivery(r: IMessagePathReport | null): CutoverCapability {
  if (!r) return unavailable('imessage-reader-unavailable');
  return { state: 'unverified', reason: imsgReason(r.ownerReply), nextStep: NEXT_IMSG_DOCTOR };
}

// A teammate leg is 'unsupported' only when the reader says so; any other
// answer (including an injected 'ready') stays unverified — an intake
// allowlist never proves a collaborator-capable transport.
function teammate(finding: Finding | undefined, readerDown: boolean): CutoverCapability {
  if (readerDown) return unavailable('imessage-reader-unavailable');
  return finding?.state === 'unsupported'
    ? { state: 'unsupported', reason: imsgReason(finding), nextStep: NEXT_DIAGNOSE }
    : { state: 'unverified', reason: imsgReason(finding), nextStep: NEXT_IMSG_DOCTOR };
}

function gmailInboxTriage(
  triage: ReturnType<typeof readGmailTriageLatest>, plans: ReturnType<typeof readGmailArchivePlanLatest>, nowMs: number,
): CutoverCapability {
  const entries = plans?.plans ?? [];
  if (!triage && entries.length === 0)
    return { state: 'unverified', reason: 'gmail-triage-evidence-missing', nextStep: 'phm fleet gmail-triage' };
  if (entries.some(p => p.unread > p.target))
    return { state: 'blocked', reason: 'gmail-inbox-over-target', nextStep: 'phm fleet gmail-archive-plan' };
  const times = [...(triage ? [triage.at] : []), ...entries.map(p => p.at)].map(at => Date.parse(at));
  const newest = Math.max(...times);
  if (!Number.isFinite(newest) || newest > nowMs || nowMs - newest > 24 * 60 * 60 * 1000)
    return { state: 'unverified', reason: 'gmail-triage-evidence-stale', nextStep: 'phm fleet gmail-triage' };
  return entries.length > 0
    ? { state: 'ready', reason: 'gmail-inboxes-within-target', nextStep: 'phm fleet gmail-archive-plan' }
    : { state: 'unverified', reason: 'gmail-unread-not-evidenced', nextStep: 'phm fleet gmail-archive-plan' };
}

/**
 * Read-only comms cutover readiness for `ashlr fleet comms-readiness`.
 * Never throws; never sends, mutates config or touches Messages itself.
 */
export async function buildCommsCutoverReadiness(deps: CommsCutoverReadinessDeps = {}): Promise<CommsCutoverReport> {
  const runsDir = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let email: EmailDiagnosis | null = null;
  try {
    email = await (deps.diagnoseEmail ?? diagnoseEmailDrop)(runsDir);
  } catch { /* A reader failure degrades to 'unverified', never to 'ready'. */ }
  let imessage: IMessagePathReport | null = null;
  try {
    imessage = (deps.checkIMessage ?? checkIMessagePath)({ runsRoot: runsDir, ...deps.imessage });
  } catch { /* A reader failure degrades to 'unverified', never to 'ready'. */ }

  let gmail: CutoverCapability;
  try {
    gmail = gmailInboxTriage((deps.readGmailTriage ?? readGmailTriageLatest)(runsDir),
      (deps.readGmailPlans ?? readGmailArchivePlanLatest)(runsDir), (deps.now ?? Date.now)());
  } catch {
    gmail = { state: 'unverified', reason: 'gmail-triage-evidence-missing', nextStep: 'phm fleet gmail-triage' };
  }

  const capabilities: CommsCutoverCapabilities = {
    emailPolling: emailPolling(email),
    emailOutbox: emailOutbox(email),
    ownerImessageIntake: ownerImessageIntake(imessage),
    ownerImessageDelivery: ownerImessageDelivery(imessage),
    teammateImessageIntake: teammate(imessage?.collaboratorIntake, !imessage),
    teammateImessageDelivery: teammate(imessage?.collaboratorDelivery, !imessage),
    gmailInboxTriage: gmail,
    linkedin: { state: 'unverified', reason: 'no-local-evidence-for-linkedin', nextStep: NEXT_DIAGNOSE },
  };
  const blockers = (Object.keys(capabilities) as (keyof CommsCutoverCapabilities)[])
    .filter(id => capabilities[id].state !== 'ready');
  return {
    schema: CUTOVER_READINESS_SCHEMA,
    coverage: 'local-evidence-only-not-delivery-proof',
    capabilities,
    overall: {
      state: blockers.length === 0 ? 'complete' : 'incomplete',
      blockers,
      commsbotRetirement: 'not-evidenced',
      nextStep: NEXT_DIAGNOSE,
    },
  };
}
