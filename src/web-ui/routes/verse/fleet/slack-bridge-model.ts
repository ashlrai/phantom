/** Fleet view model for the Slack bridge line (RQ-PHX-SLACKBRIDGEDESK671). Offline state only. */
export interface SlackBridgeView {
  v: 1; at: string; configState: string; slackSection: 'ok' | 'invalid' | 'absent'; ready: boolean;
  botTokenRefSet: boolean; appTokenRefSet: boolean; topics: string[]; slackIdentities: number; confirmedByMason: boolean;
  journal: { state: string; ingested: number; ignored: number; lastAt: string | null };
  transport: 'unknown'; next: string | null;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function narrowSlackBridge(value: unknown): SlackBridgeView | null {
  if (!isRec(value) || value.v !== 1 || typeof value.at !== 'string' || typeof value.configState !== 'string') return null;
  const j = value.journal;
  if (!['ok', 'invalid', 'absent'].includes(value.slackSection as string) || typeof value.ready !== 'boolean') return null;
  if (typeof value.botTokenRefSet !== 'boolean' || typeof value.appTokenRefSet !== 'boolean' || typeof value.confirmedByMason !== 'boolean') return null;
  if (!Array.isArray(value.topics) || !value.topics.every(t => typeof t === 'string') || !count(value.slackIdentities)) return null;
  if (!isRec(j) || typeof j.state !== 'string' || !count(j.ingested) || !count(j.ignored) || !(j.lastAt === null || typeof j.lastAt === 'string')) return null;
  if (value.next !== null && typeof value.next !== 'string') return null;
  return {
    v: 1, at: value.at, configState: value.configState, slackSection: value.slackSection as SlackBridgeView['slackSection'],
    ready: value.ready, botTokenRefSet: value.botTokenRefSet, appTokenRefSet: value.appTokenRefSet,
    topics: value.topics as string[], slackIdentities: value.slackIdentities, confirmedByMason: value.confirmedByMason,
    journal: { state: j.state, ingested: j.ingested, ignored: j.ignored, lastAt: j.lastAt as string | null },
    transport: 'unknown', next: value.next as string | null,
  };
}

function ago(iso: string, nowMs: number): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** transport is always 'unknown' offline, so every line ends with the unverified note. */
export function slackBridgeLine(view: SlackBridgeView, nowMs: number): { tone: 'ok' | 'warn' | 'muted'; text: string; next: string | null } {
  const tail = ' · connection unverified';
  if (view.configState === 'unreadable') return { tone: 'muted', text: `Slack bridge status unknown${tail}`, next: view.next };
  if (view.configState === 'missing' || view.slackSection === 'absent') return { tone: 'muted', text: `Slack bridge not set up${tail}`, next: view.next };
  if (!view.ready) return { tone: 'warn', text: `Slack bridge not ready${tail}`, next: view.next };
  const n = view.topics.length;
  const when = view.journal.lastAt === null ? null : ago(view.journal.lastAt, nowMs);
  return { tone: 'ok', text: `Slack bridge ready · ${n} ${n === 1 ? 'topic' : 'topics'} · ${when === null ? 'no messages yet' : `last message ${when}`}${tail}`, next: view.next };
}
