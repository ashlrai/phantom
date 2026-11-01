type BacklogTone = 'danger' | 'warn' | 'ok' | 'neutral';
type BacklogAction = 'merge' | 'recut' | 'refresh' | 'wait' | 'none';

const reasons: Record<string, string> = {
  'merge-conflict': 'conflicts with master',
  'base-moved': 'needs an update to master',
  'required-check-failed': 'required checks failed',
  'checks-pending': 'waiting on CI',
  'checks-none': 'waiting on CI',
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jobBacklogState(read: unknown, job: string): { number: number; state: string; action: BacklogAction; text: string; tone: BacklogTone } | null {
  if (!record(read) || read.v !== 1 || read.source !== 'ok' || !Array.isArray(read.items) || !job) return null;
  const id = job.toLowerCase();
  const item = read.items.find((row: unknown) => record(row) &&
    ((typeof row.job === 'string' && row.job.toLowerCase() === id) ||
      (typeof row.headRef === 'string' && row.headRef.toLowerCase().endsWith(id))));
  if (!record(item) || !Number.isSafeInteger(item.number) || (item.number as number) < 1 ||
      typeof item.mergeStateStatus !== 'string' || !item.mergeStateStatus ||
      !['merge', 'recut', 'refresh', 'wait', 'none'].includes(String(item.suggestedAction))) return null;
  const number = item.number as number;
  const state = item.mergeStateStatus.toUpperCase();
  const action = item.suggestedAction as BacklogAction;
  const tone: BacklogTone = state === 'DIRTY' ? 'danger' : ['BLOCKED', 'BEHIND', 'UNSTABLE'].includes(state) ? 'warn' : state === 'CLEAN' ? 'ok' : 'neutral';
  const reason = record(item.classification) && typeof item.classification.reason === 'string' ? item.classification.reason : '';
  const explanation = reason && reason !== 'checks-green' ? reasons[reason] ?? reason.replace(/-/g, ' ') : '';
  return { number, state, action, tone, text: `PR #${number} · ${state} · ${action}${explanation ? ` — ${explanation}` : ''}` };
}
