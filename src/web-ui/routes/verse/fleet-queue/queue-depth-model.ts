/** Queue depth against the fleet's live slot capacity: is the ready pile the right size? */

export interface QueueDepthLane {
  lane: string;
  running: number;
  target: number;
  held: boolean;
}

export interface QueueDepthInput {
  readyCount: number;
  lanes: readonly QueueDepthLane[];
  /** Age of each queued line in ms; null = unknown (unknown ages are never stale). */
  lineAgesMs: readonly (number | null)[];
}

export interface QueueDepth {
  liveCap: number;
  ratio: number | null;
  verdict: 'empty' | 'thin' | 'ok' | 'deep';
  staleCount: number;
  text: string;
}

const STALE_LINE_MS = 24 * 60 * 60_000;
const OK_LOW = 1;
const OK_HIGH = 3;
const TARGET_BAND = '2-3';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** '27x' — integer at or above 10, one decimal below so the 1x and 3x bounds stay readable. */
export function ratioText(ratio: number): string {
  return `${ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10}x`;
}

/**
 * liveCap sums the slot targets of lanes that are not held; a held lane drains
 * nothing so its target cannot count. A missing lane read is `lanes: []` and
 * reads 'capacity unknown' — never a zero.
 */
export function queueDepth(input: QueueDepthInput): QueueDepth {
  const ready = Math.max(0, Math.floor(input.readyCount));
  const lanes = input.lanes;
  const liveCap = lanes.reduce((sum, lane) => sum + (lane.held ? 0 : Math.max(0, lane.target)), 0);
  const ratio = liveCap > 0 ? ready / liveCap : null;
  const staleCount = input.lineAgesMs.filter(
    (age) => typeof age === 'number' && Number.isFinite(age) && age > STALE_LINE_MS,
  ).length;
  const lanesMissing = lanes.length === 0;
  const allHeld = !lanesMissing && lanes.every((lane) => lane.held);
  const verdict: QueueDepth['verdict'] =
    ready === 0 ? 'empty'
      : lanesMissing ? 'ok'
      : ratio === null ? 'deep'
      : ratio < OK_LOW ? 'thin'
      : ratio <= OK_HIGH ? 'ok'
      : 'deep';
  let text: string;
  if (lanesMissing) text = `${ready} ready · live capacity unknown.`;
  else if (allHeld) text = 'No lane has capacity: every lane is held.';
  else if (liveCap === 0) text = `${ready} ready for 0 live slots — every lane's target is 0.`;
  else if (ready === 0) text = 'Queue is empty — generators may refill.';
  else {
    const head = `${ready} ready for ${plural(liveCap, 'live slot')} (${ratioText(ratio!)}).`;
    const advice = verdict === 'thin' ? `Under the ${TARGET_BAND}x target: generators may refill.`
      : verdict === 'ok' ? `In bounds — target is ${TARGET_BAND}x.`
      : `Target is ${TARGET_BAND}x: generators should hold.`;
    text = `${head} ${advice}`;
  }
  if (staleCount > 0) text += ` ${plural(staleCount, 'line')} older than 24 h.`;
  return { liveCap, ratio, verdict, staleCount, text };
}
