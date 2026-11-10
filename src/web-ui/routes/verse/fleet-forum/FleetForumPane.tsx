import { useMemo, useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { ForumBoard } from './ForumBoard.js';
import styles from './fleet-forum.module.css';
import { forumQuery } from './forum-queries.js';

export function FleetForumPane({ visible }: PaneProps) {
  const [channel, setChannel] = useState<string | null>(null);
  const query = useMemo(() => forumQuery(channel), [channel]);
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(query);
  usePollWhileVisible(refetch, 15_000, { enabled: visible });
  if (read.data === null) return <p className={styles.message}>Forum is not in this build.</p>;
  if (read.data === undefined) return <p className={styles.message} role="status">{read.status === 'error' ? 'Forum is unavailable.' : 'Reading the forum…'}</p>;
  return <ForumBoard view={read.data} channel={channel} onChannel={setChannel} />;
}
