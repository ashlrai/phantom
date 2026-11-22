/** Pure observed admission pace. A saved reason alone cannot establish an hourly event count. */
import { objectRow, parseDispatchTick } from './compact-brief-evidence.js';
import { parseAdmissionCtl } from './load-owners.js';
import { scrubSecrets } from '../util/scrub.js';

const count = (n: unknown): number | null => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
export function summarizeAdmission(admissionJson: string | null, tickLines: string | null, now: number, targets: Record<string, unknown> = {}) {
  const guard = parseAdmissionCtl(admissionJson), unknown: Record<string, string> = {};
  const ticks = (tickLines ?? '').split('\n').map(parseDispatchTick).filter(t => t !== null).filter(t => t.at <= now && t.at >= now - 3_600_000);
  const times = ticks.map(t => t.at);
  const windowSeconds = ticks.length ? (Math.max(...times) - Math.min(...times)) / 1000 : null;
  const rate = (n: number) => windowSeconds && windowSeconds > 0 ? n * 3600 / windowSeconds : null;
  if (!ticks.length) unknown.ticks = tickLines === null ? 'dispatcher log missing or unreadable' : 'no valid ticks in the last hour';
  if (!windowSeconds) unknown.startsPerHour = 'at least two distinct observation times needed';
  if (guard.settleSeconds === null) unknown.settleSeconds = 'admission state missing, invalid or has no settle seconds';
  if (guard.why === null) unknown.lastWhy = 'admission state missing, invalid or has no reason';
  const lastWhy = guard.why === null ? null : scrubSecrets(guard.why);
  const reasons = ticks.filter(t => t.why !== null);
  const overHostEventsPerHour = reasons.length === ticks.length && ticks.length ? rate(reasons.filter(t => /\bover_(?:host|owned)\b/.test(t.why!)).length) : null;
  if (overHostEventsPerHour === null) unknown.overHostEventsPerHour = 'timestamped reason history or observation duration missing; saved why is not an event count';
  const lastTick = parseDispatchTick((tickLines ?? '').split('\n').filter(line => line.includes(' tick run=')).at(-1) ?? '');
  const fresh = lastTick !== null && lastTick.at <= now && now - lastTick.at <= 120_000;
  const latest = { running: fresh ? lastTick.running : {}, why: fresh ? 'latest tick in the bounded log tail' : 'latest tick unavailable or stale' };
  const perLane = [...new Set([...Object.keys(targets), ...Object.keys(latest.running)])].filter(lane => /^[a-z][a-z0-9-]{0,39}$/.test(lane))
    .filter(lane => Object.keys(objectRow(targets[lane])).length || lane in latest.running).sort().map(lane => {
      const running = latest.running[lane] ?? null, target = count(objectRow(targets[lane]).target);
      return { lane, running, target, gap: running !== null && target !== null ? Math.max(0, target - running) : null };
    });
  if (!perLane.length || perLane.some(l => l.gap === null)) unknown.perLane = `lane targets missing or invalid, or running counts unavailable (${latest.why})`;
  const complete = perLane.length > 0 && perLane.every(l => l.running !== null && l.target !== null);
  const running = complete ? perLane.reduce((n, l) => n + l.running!, 0) : null;
  const target = complete ? perLane.reduce((n, l) => n + l.target!, 0) : null;
  const startsPerHour = rate(ticks.reduce((n, t) => n + t.launched, 0));
  const ticksWithLaunch = ticks.length ? ticks.filter(t => t.launched > 0).length : null;
  const walls = ticks.map(t => t.wall).sort((a, b) => a - b), middle = Math.floor(walls.length / 2);
  const medianTickWallSeconds = walls.length ? walls.length % 2 ? walls[middle]! : (walls[middle - 1]! + walls[middle]!) / 2 : null;
  const rounded = (n: number | null) => n === null ? 'unknown' : Math.round(n * 10) / 10;
  const why = lastWhy?.replace(/\bover_host\b/g, 'host load too high').replace(/\bover_owned\b/g, 'fleet load too high').replaceAll('_', ' ');
  const answer = `${running ?? 'unknown'} of ${target ?? 'unknown'} running: guard reports ${guard.settleSeconds ?? 'unknown'} s settle (${why ?? 'reason unknown'}); ${rounded(startsPerHour)} starts/hour over ${windowSeconds ?? 'unknown'} seconds of retained ticks, launches on ${ticksWithLaunch ?? 'unknown'}/${ticks.length || 'unknown'} ticks; ${rounded(overHostEventsPerHour)} host or fleet load events/hour`;
  return { startsPerHour, ticksWithLaunch, ticks: ticks.length || null, settleSeconds: guard.settleSeconds, lastWhy,
    overHostEventsPerHour, medianTickWallSeconds, perLane, windowSeconds, basis: 'retained ticks in last hour; first to last tick',
    answer: scrubSecrets(answer), unknown };
}
