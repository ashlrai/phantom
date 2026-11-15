/**
 * Real-state readers for the status digest. Reuses the existing readers (runs
 * dir lane state, merge truth, release facts, NEEDS-MASON, MASON-INBOX); any
 * reader that throws or reports itself unavailable becomes an "unknown" fact.
 */
import { readInstalledBundleVersion, versionNewer } from '../app-update-status.js';
import { gatherBriefFacts, type BriefFacts } from '../comms/leader-brief.js';
import { readNeedsMason } from '../fleet/needs-mason-resolve.js';
import { readFleetRunsDirState, type FleetRunsDirState } from '../fleet/runs-dir-state.js';
import { readInboxEntries, type InboxEntry } from '../fleet/mason-inbox.js';
import { defaultReleasePublicReader, verifyLatestWorkbenchRelease } from '../release-public-facts.js';
import type { Fact, StatusDigestInput } from './status-digest.js';

export interface StatusDigestSources {
  installedVersion: () => string | null;
  /** Newest published release with its desktop asset; throws when unreadable. */
  publishedVersion: (nowMs: number) => Promise<string>;
  mergeFacts: (sinceMs: number, nowMs: number) => Promise<Pick<BriefFacts, 'shipped' | 'mergeCountUnavailable'>>;
  runsState: (runsDir: string, nowMs: number) => Promise<Pick<FleetRunsDirState, 'lanes' | 'sources' | 'runsDirPresent'>>;
  needs: (runsDir: string) => { status: string; items: Array<{ text: string }> };
  inbox: (runsDir: string) => Promise<{ sourceState: string; entries: InboxEntry[] }>;
}

const HOUR = 3_600_000;
const NEEDS_READER_UNAVAILABLE = 'NEEDS-MASON.md could not be read';
/** The hard limits: secrets, money, outside sends, data destruction. Everything else is left out. */
const HARD_LIMIT = /\b(?:secrets?|tokens?|api[- ]?keys?|credentials?|passwords?|2fa|mfa|payments?|billing|invoice|purchase|spend|pay|refund|wire|outside send|external send|send (?:an? )?(?:email|message|dm)|publicly|announce|delete|destroy|wipe|purge|force[- ]push|drop table|data loss)\b|\$\d/i;
export const isHardLimitAsk = (text: string): boolean => HARD_LIMIT.test(text);

const defaults: StatusDigestSources = {
  installedVersion: readInstalledBundleVersion,
  publishedVersion: async nowMs => {
    const release = await verifyLatestWorkbenchRelease(defaultReleasePublicReader(), nowMs, AbortSignal.timeout(20_000));
    if (!release.macDownloadUrl) throw new Error('newest published release has no desktop asset');
    return release.version;
  },
  mergeFacts: (sinceMs, nowMs) => gatherBriefFacts(sinceMs, nowMs),
  runsState: (runsDir, nowMs) => readFleetRunsDirState({ runsDir, now: () => nowMs }),
  needs: runsDir => readNeedsMason({ runsDir }),
  inbox: runsDir => readInboxEntries({ runsDir, limit: 200 }),
};

const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Inbox headings carry "YYYY-MM-DD HH:MM" Eastern wall time. */
export function inboxAtMs(at: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at)) return null;
  for (const offsetHours of [4, 5]) {
    const ms = Date.parse(`${at.replace(' ', 'T')}:00Z`) + offsetHours * HOUR;
    const p = Object.fromEntries(ET.formatToParts(ms).map(part => [part.type, part.value]));
    if (`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === at) return ms;
  }
  return null;
}

async function fact<T>(read: () => Promise<T> | T, reason: string): Promise<Fact<T>> {
  try { return { ok: true, value: await read() }; } catch { return { ok: false, reason }; }
}

export async function gatherStatusDigestInput(runsDir: string, now: Date, overrides: Partial<StatusDigestSources> = {}): Promise<StatusDigestInput> {
  const src = { ...defaults, ...overrides };
  const nowMs = now.getTime();
  const merged = (hours: number): Promise<Fact<number>> => fact(async () => {
    const facts = await src.mergeFacts(nowMs - hours * HOUR, nowMs);
    if (facts.mergeCountUnavailable) throw new Error('unavailable');
    return facts.shipped.filter(item => /^ashlrai\/phantom#\d+/.test(item.text)).length;
  }, 'GitHub merge count unavailable or incomplete');

  const [installed, published, hour, day, runs, inbox] = await Promise.all([
    fact(() => { const v = src.installedVersion(); if (!v) throw new Error('none'); return v; }, 'installed app version not readable'),
    fact(() => src.publishedVersion(nowMs), 'published release not readable'),
    merged(1), merged(24),
    fact(() => src.runsState(runsDir, nowMs), 'lane state not readable'),
    fact(() => src.inbox(runsDir), 'MASON-INBOX.md not readable'),
  ]);

  const lanes: Fact<StatusDigestInput['lanes'] extends Fact<infer L> ? L : never> = !runs.ok ? runs
    : runs.value.sources.status !== 'healthy' ? { ok: false, reason: runs.value.runsDirPresent ? 'queue/status.json missing or invalid' : 'runs dir missing' }
      : { ok: true, value: runs.value.lanes.map(({ lane, running, target, held, heldReason }) => ({ lane, running, target, held, heldReason })) };

  const needsFact = await fact(() => {
    const result = src.needs(runsDir);
    if (result.status !== 'available' && result.status !== 'missing') throw new Error(NEEDS_READER_UNAVAILABLE);
    return result.items.filter(item => isHardLimitAsk(item.text)).length;
  }, NEEDS_READER_UNAVAILABLE);

  let topP0: StatusDigestInput['topP0'];
  if (!inbox.ok) topP0 = inbox;
  else if (inbox.value.sourceState === 'degraded') topP0 = { ok: false, reason: 'MASON-INBOX.md not readable' };
  else {
    // parseInbox returns newest first.
    const entry = inbox.value.entries.find(e => e.priority === 'P0' && e.text.trim());
    const at = entry ? inboxAtMs(entry.at) : null;
    topP0 = { ok: true, value: entry ? { text: entry.text, ageMs: at === null ? null : Math.max(0, nowMs - at) } : null };
  }

  const updatePending = installed.ok && published.ok ? versionNewer(published.value, installed.value) : null;
  return { installedVersion: installed, publishedVersion: published, updatePending, mergesLastHour: hour, mergesLast24h: day, lanes, needsMason: needsFact, topP0 };
}
