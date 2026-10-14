import { MAX_HINT_TARGETS } from './hint-model.js';

export interface HintBadgeBox { id: string; left: number; top: number; width: number; height: number }
export interface HintObstacle { left: number; top: number; width: number; height: number }
const MAX_ATTEMPTS = MAX_HINT_TARGETS * 4;
const GAP = 2;
const overlaps = (a: HintObstacle, b: HintObstacle) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

interface Candidate { box: HintBadgeBox; row: number; distance: number; order: number }
const before = (a: Candidate, b: Candidate) => a.row < b.row || (a.row === b.row && (a.distance < b.distance || (a.distance === b.distance && a.order < b.order)));
// Stable priority queue: preserve insertion order on ties without sorting the
// growing search frontier on every attempt.
function push(queue: Candidate[], candidate: Candidate) {
  let index = queue.length;
  queue.push(candidate);
  while (index > 0) {
    const parent = (index - 1) >>> 1;
    if (!before(candidate, queue[parent])) break;
    queue[index] = queue[parent]; index = parent;
  }
  queue[index] = candidate;
}
function pop(queue: Candidate[]): HintBadgeBox {
  const first = queue[0]; const last = queue.pop()!;
  if (queue.length) {
    let index = 0;
    while (index * 2 + 1 < queue.length) {
      let child = index * 2 + 1;
      if (child + 1 < queue.length && before(queue[child + 1], queue[child])) child++;
      if (!before(queue[child], last)) break;
      queue[index] = queue[child]; index = child;
    }
    queue[index] = last;
  }
  return first.box;
}

/** Actual rendered measurements, never assumed font/glyph sizes. Null fails closed for an unlabelable layout. */
export function placeHintBadges(measured: readonly HintBadgeBox[], viewport: { width: number; height: number }, reserved: readonly HintObstacle[] = []): HintBadgeBox[] | null {
  if (measured.length > MAX_HINT_TARGETS || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) return null;
  if (reserved.length > MAX_HINT_TARGETS || reserved.some((box) => ![box.left, box.top, box.width, box.height].every(Number.isFinite) || box.width < 0 || box.height < 0)) return null;
  const ids = new Set<string>();
  const placed: HintBadgeBox[] = [];
  for (const badge of measured) {
    if (!badge.id || ids.has(badge.id)) return null;
    ids.add(badge.id);
    if (![badge.left, badge.top, badge.width, badge.height].every(Number.isFinite) || badge.width <= 0 || badge.height <= 0 || badge.width > viewport.width || badge.height > viewport.height) return null;
    const clamp = (left: number, top: number) => ({ ...badge, left: Math.max(0, Math.min(left, viewport.width - badge.width)), top: Math.max(0, Math.min(top, viewport.height - badge.height)) });
    const origin = clamp(badge.left, badge.top);
    const queue: Candidate[] = [];
    let order = 0;
    const enqueue = (box: HintBadgeBox) => push(queue, { box, row: Number(box.top !== origin.top), distance: (box.left - origin.left) ** 2 + (box.top - origin.top) ** 2, order: order++ });
    enqueue(origin);
    const obstacles = [...reserved, ...placed];
    const seen = new Set<string>();
    let position: HintBadgeBox | undefined;
    // Search nearby sides of actual obstacles. The fixed registry and attempt cap
    // bound work; prefer the same row, then distance, to retain target association.
    for (let attempt = 0; queue.length && attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = pop(queue);
      const key = `${candidate.left},${candidate.top}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const obstacle = obstacles.find((box) => overlaps(candidate, box));
      if (!obstacle) { position = candidate; break; }
      enqueue(clamp(obstacle.left + obstacle.width + GAP, candidate.top));
      enqueue(clamp(obstacle.left - badge.width - GAP, candidate.top));
      enqueue(clamp(candidate.left, obstacle.top + obstacle.height + GAP));
      enqueue(clamp(candidate.left, obstacle.top - badge.height - GAP));
    }
    if (!position) return null;
    placed.push(position);
  }
  return placed;
}
