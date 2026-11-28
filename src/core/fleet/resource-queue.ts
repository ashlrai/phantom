import { join } from 'node:path';
import { readSource } from './runs-parked-queue.js';
import { derivedRowCodes, marketContext, marketLaneView, parseReadyMarketRows, readySpecCell, type ReadyMarketRow } from './unfed-market.js';

const MAX_BYTES = 2 * 1024 * 1024;
const FRESH_MS = 120_000;

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export async function readResourceQueue(runsDir: string, now: number, status: unknown) {
  const snapshot = object(status), admission = object(snapshot.admission);
  const tick = Date.parse(String(snapshot.last_tick ?? ''));
  if (snapshot.schema !== 'dispatchd.status.v1' || !(tick <= now && now - tick <= FRESH_MS) ||
      (snapshot.paused !== null && snapshot.paused !== false) || admission.admit !== true ||
      admission.decision === 'stop' || admission.gate_reason) return null;
  const read = (name: string, max = MAX_BYTES) => readSource(join(runsDir, name), max, false);
  const [ready, slots, models, budget, adaptive, hold, retired, router, pause, orchOff] = await Promise.all([
    read('queue/ready.tsv'), read('queue/slots.json'), read('models.json'), read('queue/budget-overrides.json'),
    read('queue/adaptive.json'), read('HOLD'), read('queue/RETIRED'), read('queue/router-queue.md', 32 * 1024 * 1024),
    read('PAUSE'), read('ORCH_OFF'),
  ]);
  if (ready.state !== 'healthy' || slots.state !== 'healthy' || pause.state !== 'missing' || orchOff.state !== 'missing' ||
      [models, budget, adaptive, hold, retired, router].some(row => row.state === 'degraded')) return null;
  const ctx = marketContext({ slots: slots.text, models: models.text, budget: budget.text, adaptive: adaptive.text, hold: hold.text, nowMs: now });
  if (!ctx) return null;
  const blockedIds = new Set(retired.text.split(/\s+/));
  for (const match of router.text.matchAll(/^- (?:RETIRED|HOLD(?:-[A-Z]+)*) ([^[(\n]*)/gm)) {
    for (const token of match[1]!.trim().split(/\s+/)) blockedIds.add(token);
  }
  const lines = ready.text.split('\n');
  const ids = new Map<string, number>();
  for (const line of lines) {
    const id = line.split('\t', 1)[0]!;
    ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  const parkedIds = new Set(lines.flatMap(line => {
    const [first, second] = line.split('\t', 2);
    return first?.startsWith('PARKED-') && second ? [second] : [];
  }));
  const lanes = new Map(Object.entries(object(snapshot.lanes)).flatMap(([lane, raw]) => {
    const row = object(raw), running = count(row.running), target = count(row.effective_target ?? row.target);
    if (running === null || target === null || typeof row.held !== 'boolean' || !Object.hasOwn(ctx.slots, lane)) return [];
    return [[lane, marketLaneView(lane, running, target, row.held, ctx,
      typeof row.healthy === 'boolean' ? row.healthy : null)] as const];
  }));
  const rows = lines.flatMap((line, index) => {
    const cells = line.replace(/\r$/, '').split('\t');
    if (cells.length < 5 || !cells[4] || ids.get(cells[0]!) !== 1 || parkedIds.has(cells[0]!) || blockedIds.has(cells[0]!)) return [];
    const row = parseReadyMarketRows(cells.join('\t'), router.text).rows[0];
    if (!row) return [];
    const spec = readySpecCell(cells[5]);
    const source = row.hint === null ? null : lanes.get(row.hint);
    const canReroute = cells.length === 6 && spec !== null && spec !== 'invalid' && spec.exclusive !== true &&
      (row.hint === null || (source && !source.local && !source.held)) &&
      (!cells[2] || (lanes.has(cells[2]) && !lanes.get(cells[2])!.held && !lanes.get(cells[2])!.local));
    return [{ row, index, spec: canReroute ? spec : null }];
  });
  const eligible = (row: ReadyMarketRow, lane: string, requireDispatchHeadroom: boolean) => {
    const view = lanes.get(lane);
    return view?.costClass === 'included' && derivedRowCodes(row, lane,
      requireDispatchHeadroom ? view : { ...view, target: view.running + 1 })[0] === 'deferred_after_selection';
  };
  return { text: ready.text, tick, lines, rows, eligible,
    lanes: new Map([...lanes].map(([lane, { running, target, costClass }]) => [lane, { running, target, costClass }] as const)) };
}
