/**
 * Plugins and Skills panes: read-only lists of what fleet agents have. Each
 * reads the same typed data as `phm plugins list --all --json` and
 * `phm skills list --all --json`; a source that could not be read says
 * "unknown" and adds no rows. Styled like the Connectors panel.
 */
import type { InstalledPanel } from '../../../../core/fleet/installed-panels.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from '../sections/SettingsSection.module.css';

const queryFor = (kind: 'plugins' | 'skills'): QueryDef<InstalledPanel> =>
  ({ key: `fleet-${kind}-panel`, fetch: signal => apiGet(`/api/verse/fleet/runs/${kind}`, signal) });
const pluginsQuery = queryFor('plugins');
const skillsQuery = queryFor('skills');

const enabledLabel = (value: boolean | 'unknown') => value === 'unknown' ? 'Enabled: unknown' : value ? 'Enabled' : 'Off';

function InstalledList({ title, noun, query, cli, visible }: { title: string; noun: string; query: QueryDef<InstalledPanel>; cli: string; visible: boolean }) {
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const data = read.data;
  return <section className={styles.panel} aria-label={title}>
    <div className={styles.panelHead}>
      <h3 className={styles.panelTitle}>{title}</h3>
      <button type="button" onClick={() => refresh()}>Refresh {noun}</button>
    </div>
    <p>What fleet agents have, and who gets it. Agents read the same list with <code>{cli}</code>.</p>
    {!data ? <p role={read.status === 'error' ? 'alert' : 'status'}>{read.status === 'error' ? `${title}: unknown (could not load). Refresh to try again.` : `Reading ${noun}…`}</p> : <>
      <ul aria-label={`${title} sources`}>
        {data.sources.map(s => <li key={s.source}>{s.source}: {s.state === 'read' ? `${s.count} ${noun}` : s.state === 'none' ? `no ${noun}` : 'unknown (could not read)'}</li>)}
      </ul>
      <div className={styles.panelBody}>
        {data.items.length === 0 && <p>No {noun} found.</p>}
        {data.items.map(item => <div className={styles.row} key={`${item.source}/${item.name}`}>
          <div><strong>{item.name}</strong><p>{item.source} · {item.agents} · Last used: {item.lastUsed}</p></div>
          <span>{enabledLabel(item.enabled)}</span>
        </div>)}
      </div>
    </>}
  </section>;
}

export function PluginsPane({ visible }: PaneProps) {
  return <InstalledList title="Plugins" noun="plugins" query={pluginsQuery} cli="phm plugins list --all --json" visible={visible} />;
}

export function SkillsPane({ visible }: PaneProps) {
  return <InstalledList title="Skills" noun="skills" query={skillsQuery} cli="phm skills list --all --json" visible={visible} />;
}
