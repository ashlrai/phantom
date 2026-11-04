/** Pure snapshot comparison, following modelcaps' explicit evidence semantics. */
import { radarSnapshotSchema, type RadarData, type RadarSnapshot } from './snapshot.js';

export interface RadarDiff {
  id: string;
  kind: RadarData['kind'];
  status: 'baseline' | 'unchanged' | 'changed';
  before: RadarData | null;
  after: RadarData;
  added: string[];
  removed: string[];
  changed: Array<{ id: string; before: string; after: string }>;
}
export function diffRadarSnapshots(before: RadarSnapshot | null, after: RadarSnapshot): RadarDiff {
  const current = radarSnapshotSchema.parse(after);
  const previous = before === null ? null : radarSnapshotSchema.parse(before);
  if (previous && (previous.id !== current.id || previous.url !== current.url || previous.data.kind !== current.data.kind)) {
    throw new Error('Cannot compare different Radar sources');
  }
  const result: RadarDiff = {
    id: current.id, kind: current.data.kind,
    status: previous === null ? 'baseline' : JSON.stringify(previous.data) === JSON.stringify(current.data) ? 'unchanged' : 'changed',
    before: previous?.data ?? null, after: current.data, added: [], removed: [], changed: [],
  };
  if (!previous) return result;
  if ((previous.data.kind === 'atom' || previous.data.kind === 'rss') && (current.data.kind === 'atom' || current.data.kind === 'rss')) {
    const old = new Map(previous.data.entries.map(entry => [entry.id, entry.title]));
    const next = new Map(current.data.entries.map(entry => [entry.id, entry.title]));
    if (old.size !== previous.data.entries.length || next.size !== current.data.entries.length) throw new Error('Duplicate Atom identity');
    result.added = [...next.keys()].filter(id => !old.has(id)).sort();
    result.removed = [...old.keys()].filter(id => !next.has(id)).sort();
    result.changed = [...next].filter(([id, title]) => old.has(id) && old.get(id) !== title)
      .map(([id, title]) => ({ id, before: old.get(id)!, after: title })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    result.status = result.added.length || result.removed.length || result.changed.length ? 'changed' : 'unchanged';
  } else if (previous.data.kind === 'page' && current.data.kind === 'page') {
    const oldHeadings = new Set(previous.data.headings);
    const newHeadings = new Set(current.data.headings);
    result.added = [...newHeadings].filter(heading => !oldHeadings.has(heading)).sort();
    result.removed = [...oldHeadings].filter(heading => !newHeadings.has(heading)).sort();
  } else if ('version' in previous.data && 'version' in current.data && previous.data.version !== current.data.version) {
    result.changed = [{ id: 'version', before: previous.data.version, after: current.data.version }];
  }
  return result;
}
