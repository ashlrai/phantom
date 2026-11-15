import { emitKeypressEvents } from 'node:readline';
import type { JobTimeline } from '../core/run/job-replay.js';

export function renderReplay(timeline: JobTimeline, offset = 0, cols = 100, rows = 24): string {
  const width = Math.max(20, Math.min(300, cols));
  const count = Math.max(1, rows - 4);
  return [
    'Job replay · recorded steps',
    `${timeline.steps.length} steps${timeline.incomplete ? ' · incomplete final record omitted' : ''} · j/k scroll · q quit`,
    ...timeline.steps.slice(offset, offset + count).map((step, index) =>
      `${offset + index + 1}. ${step.at} [${step.kind}] ${step.text}`.slice(0, width)),
    ...(timeline.steps.length ? [] : ['No recorded steps.']),
    `Steps ${timeline.steps.length ? offset + 1 : 0}-${Math.min(offset + count, timeline.steps.length)} / ${timeline.steps.length}`,
  ].join('\n') + '\n';
}

export async function runReplay(timeline: JobTimeline, once: boolean): Promise<number> {
  if (once || !process.stdout.isTTY || !process.stdin.isTTY) {
    process.stdout.write(renderReplay(timeline, 0, 300, timeline.steps.length + 4));
    return 0;
  }
  const input = process.stdin;
  const wasRaw = input.isRaw;
  let offset = 0;
  const paint = () => process.stdout.write('\x1b[H\x1b[2J' + renderReplay(timeline, offset,
    process.stdout.columns || 80, process.stdout.rows || 24));
  let finish: () => void = () => {};
  const quit = () => finish();
  const keypress = (_: string, key: { name?: string; ctrl?: boolean }) => {
    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) { quit(); return; }
    const max = Math.max(0, timeline.steps.length - Math.max(1, (process.stdout.rows || 24) - 4));
    if (key.name === 'j' || key.name === 'down') offset = Math.min(max, offset + 1);
    if (key.name === 'k' || key.name === 'up') offset = Math.max(0, offset - 1);
    paint();
  };
  try {
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    await new Promise<void>(resolve => {
      finish = resolve;
      input.on('keypress', keypress);
      input.on('end', quit);
      process.on('SIGINT', quit);
      process.on('SIGTERM', quit);
      process.stdout.on('resize', paint);
      paint();
    });
    return 0;
  } finally {
    input.off('keypress', keypress);
    input.off('end', quit);
    process.off('SIGINT', quit);
    process.off('SIGTERM', quit);
    process.stdout.off('resize', paint);
    input.setRawMode(wasRaw);
    input.pause();
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
}
