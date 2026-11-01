export interface PlannerRunRecord {
  startedAt: number | null;
  finishedAt: number | null;
  ok: boolean | null;
  text: string | null;
  needsSlate: boolean;
}

let record: PlannerRunRecord = { startedAt: null, finishedAt: null, ok: null, text: null, needsSlate: false };
const listeners = new Set<() => void>();

export function getPlannerRun(): PlannerRunRecord { return record; }
export function subscribePlannerRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setPlannerRun(next: PlannerRunRecord): void {
  record = next;
  for (const listener of listeners) listener();
}
