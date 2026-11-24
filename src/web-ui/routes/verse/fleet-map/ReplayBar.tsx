/**
 * The Map pane's time control (`phm map replay`): one slider over the last 6 hours, a play button,
 * and "Back to live" while a past moment is showing. The far right of the slider is now.
 * Times with no recorded history are marked in the strip under the slider; they are never drawn as an empty fleet.
 */
import { useEffect } from 'react';
import type { MapReplay, MapReplayFrame } from '../../../../core/fleet/map-replay.js';
import styles from './fleet-map.module.css';

export const REPLAY_PLAY_MS = 800;
const clock = (frame: MapReplayFrame) => `${frame.at.slice(11, 16)} UTC`;
const n = (rows: readonly unknown[] | null) => rows === null ? 'unknown' : String(rows.length);

/** One plain line for a frame, the same words on every surface. */
export function frameSummary(frame: MapReplayFrame): string {
  if (frame.state === 'unknown') return `${clock(frame)}: history unknown, nothing was recorded for this time.`;
  return `${clock(frame)}: ${n(frame.running)} running, ${n(frame.launched)} launched, ${n(frame.prsOpened)} PR${frame.prsOpened?.length === 1 ? '' : 's'} opened, ${n(frame.merged)} merged, ${n(frame.messages)} message line${frame.messages?.length === 1 ? '' : 's'}.`;
}

interface ReplayBarProps {
  replay: MapReplay;
  /** The frame showing, or null for live. */
  index: number | null;
  playing: boolean;
  onIndex: (index: number | null) => void;
  onPlaying: (playing: boolean) => void;
}
export function ReplayBar({ replay, index, playing, onIndex, onPlaying }: ReplayBarProps) {
  const last = replay.frames.length, value = index ?? last, frame = index === null ? null : replay.frames[index];
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      if (value + 1 >= last) { onIndex(null); onPlaying(false); } else onIndex(value + 1);
    }, REPLAY_PLAY_MS);
    return () => clearInterval(timer);
  }, [playing, value, last, onIndex, onPlaying]);
  const choose = (next: number) => { onIndex(next >= last ? null : next); };
  const text = frame ? `${clock(frame)}, ${frame.state === 'unknown' ? 'history unknown' : `${n(frame.running)} jobs running`}` : 'Now (live)';
  return <div className={styles.replay} role="group" aria-label="Replay the fleet">
    <button type="button" aria-pressed={playing} onClick={() => { if (playing) onPlaying(false); else { if (index === null) onIndex(0); onPlaying(true); } }}>{playing ? 'Pause' : 'Play'}</button>
    <input type="range" min={0} max={last} step={1} value={value} aria-label="Replay time" aria-valuetext={text}
      onChange={event => { onPlaying(false); choose(Number(event.target.value)); }} />
    {index !== null && <button type="button" onClick={() => { onPlaying(false); onIndex(null); }}>Back to live</button>}
    <ol className={styles.history} aria-label="History by time">
      {replay.frames.map((row, i) => <li key={row.at} data-state={row.state} data-current={i === index ? 'true' : undefined}
        title={row.state === 'known' ? clock(row) : `${clock(row)}: ${row.state === 'unknown' ? 'unknown' : 'partly unknown'}`} />)}
    </ol>
    <p className={styles.notice} aria-live="polite">{frame ? `Showing ${frameSummary(frame)}` : `Live. Drag back to replay the last ${Math.round(replay.frames.length * replay.stepSeconds / 3600)} hours.`}</p>
    {replay.gaps.length > 0 && <ul className={styles.gaps} aria-label="Replay unknown">{replay.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
  </div>;
}
