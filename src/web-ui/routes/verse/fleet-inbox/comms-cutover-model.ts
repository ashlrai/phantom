/** The "off Grok Bot" cutover checklist from GET /api/verse/fleet/comms-status (`cutover`). Narrowed defensively; unknown ids and states are dropped, never repaired. */
export type CutoverState = 'ready' | 'blocked' | 'unsupported' | 'unverified';

export const CUTOVER_LABELS = {
  emailPolling: 'Email intake',
  emailOutbox: 'Email reply outbox',
  ownerImessageIntake: "Mason's iMessage in",
  ownerImessageDelivery: "Mason's iMessage out",
  teammateImessageIntake: "Dot's iMessage in",
  teammateImessageDelivery: "Dot's iMessage out",
  gmailInboxTriage: 'Gmail triage',
  linkedin: 'LinkedIn',
} as const;

export const CUTOVER_STATE_WORDS: Record<CutoverState, string> = {
  ready: 'Ready', blocked: 'Blocked', unsupported: 'Not on this Mac', unverified: 'Unverified',
};

export interface CutoverRow {
  id: keyof typeof CUTOVER_LABELS;
  label: string;
  state: CutoverState;
  stateWord: string;
  reason: string;
  nextStep: string;
}

export interface CutoverView {
  complete: boolean;
  rows: CutoverRow[];
}

const CAPABILITY_TOTAL = Object.keys(CUTOVER_LABELS).length;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isState = (value: unknown): value is CutoverState => typeof value === 'string' && value in CUTOVER_STATE_WORDS;

export function readCutover(data: unknown): CutoverView | null {
  if (!isRecord(data) || !isRecord(data.cutover)) return null;
  const { overall, capabilities } = data.cutover;
  if (!isRecord(overall) || !isRecord(capabilities)) return null;
  const rows: CutoverRow[] = [];
  for (const id of Object.keys(CUTOVER_LABELS) as CutoverRow['id'][]) {
    const c = capabilities[id];
    if (!isRecord(c) || !isState(c.state) || typeof c.reason !== 'string' || typeof c.nextStep !== 'string') continue;
    rows.push({ id, label: CUTOVER_LABELS[id], state: c.state, stateWord: CUTOVER_STATE_WORDS[c.state], reason: c.reason, nextStep: c.nextStep });
  }
  if (rows.length === 0) return null;
  return { complete: overall.state === 'complete', rows };
}

export function cutoverHeadline(view: CutoverView): string {
  const ready = view.rows.filter(row => row.state === 'ready').length;
  const base = `Off Grok Bot: ${ready} of ${CAPABILITY_TOTAL} ready`;
  return view.complete ? `${base} · Commsbot retirement not proven locally` : base;
}
