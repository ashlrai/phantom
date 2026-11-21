/**
 * Settings ▸ Live build limits — how far behind master the running build may be before the fleet raises the
 * `build-stale` alert. Saved to config (`fleet.buildStale`) and read back; ASHLR_BUILD_STALE_COMMITS / _HOURS
 * still override it for a one-off, and the row says so rather than showing a number that is not in force.
 */
import { useState } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { invalidate } from '../../../data/cache.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useMutationHold, useQuery } from '../../../data/hooks.js';
import { buildStaleLimitsQuery, postBuildStaleLimits, type BuildStaleLimitsView } from './build-stale-limits-queries.js';
import { Panel, SettingRow } from './SettingRow.js';
import styles from './SettingsSection.module.css';

type Draft = { commits: string; hours: string };
const show = (v: BuildStaleLimitsView): Draft => ({ commits: String(v.saved.commits ?? v.defaults.commits), hours: String(v.saved.hours ?? v.defaults.hours) });
/** A whole number in range, or null when the box holds something else. */
const whole = (text: string, r: { min: number; max: number }): number | null => {
  const n = Number(text);
  return text.trim() !== '' && Number.isInteger(n) && n >= r.min && n <= r.max ? n : null;
};

export function BuildLimitsRow() {
  const read = useQuery(buildStaleLimitsQuery);
  const { hasHold } = useMutationHold();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  if (read.data === undefined) return null;
  if (read.data === null) return <Panel title="Live build limits"><p className={styles.panelNote}>Live build limits unavailable.</p></Panel>;
  const view = read.data;
  const value = draft ?? show(view);
  const commits = whole(value.commits, view.ranges.commits);
  const hours = whole(value.hours, view.ranges.hours);
  const valid = commits !== null && hours !== null;
  const changed = draft !== null && (commits !== (view.saved.commits ?? view.defaults.commits) || hours !== (view.saved.hours ?? view.defaults.hours));
  const customised = view.saved.commits !== null || view.saved.hours !== null;

  async function save(next: { commits: number | null; hours: number | null }) {
    setPending(true);
    try {
      await postBuildStaleLimits(next);
      toast.show(next.commits === null && next.hours === null ? 'Live build limits reset to the defaults.' : 'Live build limits saved.', 'success');
      setDraft(null);
      invalidate(buildStaleLimitsQuery.key);
    } catch (error) { toast.show(error instanceof ApiError || error instanceof TypeError || !(error instanceof Error) ? readFailureReason(error) : error.message, 'danger'); }
    finally { setPending(false); }
  }
  const envNote = (on: boolean, name: string, now: number) => on ? ` ${name} is set in the environment, so ${now} is in force instead.` : '';
  return <Panel title="Live build limits">
    <SettingRow label="Commits behind master" htmlFor="build-stale-commits"
      description={`The alert fires past this many commits. Default ${view.defaults.commits}.${envNote(view.envOverride.commits, 'ASHLR_BUILD_STALE_COMMITS', view.limits.commits)}`}>
      <input id="build-stale-commits" aria-label="Commits behind master" type="number" inputMode="numeric" min={view.ranges.commits.min} max={view.ranges.commits.max}
        value={value.commits} disabled={pending || !hasHold} aria-invalid={commits === null}
        onChange={e => setDraft({ ...value, commits: e.target.value })} />
    </SettingRow>
    <SettingRow label="Hours since a missed merge" htmlFor="build-stale-hours"
      description={`The alert fires when the build lacks a commit that merged longer ago than this. Default ${view.defaults.hours}.${envNote(view.envOverride.hours, 'ASHLR_BUILD_STALE_HOURS', view.limits.hours)}`}>
      <input id="build-stale-hours" aria-label="Hours since a missed merge" type="number" inputMode="numeric" min={view.ranges.hours.min} max={view.ranges.hours.max}
        value={value.hours} disabled={pending || !hasHold} aria-invalid={hours === null}
        onChange={e => setDraft({ ...value, hours: e.target.value })} />
    </SettingRow>
    {hasHold ? <>
      <Button size="sm" disabled={!changed || !valid || pending} onClick={() => void save({ commits, hours })}>Save</Button>
      {customised ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => void save({ commits: null, hours: null })}>Reset to defaults</Button> : null}
    </> : <p className={styles.panelNote}>Unlock the mutation hold to change these limits.</p>}
  </Panel>;
}
