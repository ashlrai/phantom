/**
 * The filter bar on the Map: three pickers (lane, repo, state) and Clear. Desktop and phone draw this one
 * component; the matching is `filterLiveMap`, the same function `phm map --lane/--repo/--state` runs.
 * The pickers list what the map holds right now, plus a choice already made that has since gone quiet.
 */
import { isMapFilterActive, mapFilterChoices, type MapFilter } from '../../../../core/fleet/map-filter.js';
import type { FleetLiveMap } from '../../../../core/fleet/live-map.js';
import styles from './fleet-map.module.css';

const STATE_WORD: Readonly<Record<string, string>> = { running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed', unknown: 'Unknown' };

export interface MapFilterBarProps { map: Pick<FleetLiveMap, 'nodes'>; filter: MapFilter; onChange: (next: MapFilter) => void }

export function MapFilterBar({ map, filter, onChange }: MapFilterBarProps) {
  const choices = mapFilterChoices(map);
  const withChosen = (list: readonly string[], chosen: string | null | undefined) => chosen && !list.includes(chosen) ? [...list, chosen] : list;
  const pick = (label: string, key: 'lane' | 'repo' | 'state', options: readonly string[], word: (value: string) => string = value => value) =>
    <label className={styles.filterPick}>{label}
      <select value={filter[key] ?? ''} onChange={event => onChange({ ...filter, [key]: event.target.value || null })}>
        <option value="">All</option>
        {withChosen(options, filter[key]).map(value => <option key={value} value={value}>{word(value)}</option>)}
      </select></label>;
  return <div className={styles.filterBar} role="group" aria-label="Filter the map">
    {pick('Lane', 'lane', choices.lanes)}
    {pick('Repo', 'repo', choices.repos)}
    {pick('State', 'state', choices.states, value => STATE_WORD[value] ?? value)}
    {isMapFilterActive(filter) && <button type="button" onClick={() => onChange({})}>Clear</button>}
  </div>;
}
