import { useQuery, useRefetch } from '../../../data/hooks.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { leaderQuery } from '../command/surface-data.js';
import { LeaderConversation } from '../leader/LeaderConversation.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { SectionVisibilityProvider, usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './leader-thread.module.css';

export function LeaderThreadPane({ visible }: Pick<PaneProps, 'visible'>) {
  const leader = useQuery(leaderQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(leaderQuery);
  const actions = useSurfaceActions();
  usePollWhileVisible(refetch, 5_000, { enabled: visible });

  return <div className={styles.root}>
    <ActionStatus actions={actions} />
    <SectionVisibilityProvider visible={visible}>
      <LeaderConversation leader={leader.data} actions={actions} dormant={!visible} />
    </SectionVisibilityProvider>
    {actions.dialogs}
  </div>;
}
