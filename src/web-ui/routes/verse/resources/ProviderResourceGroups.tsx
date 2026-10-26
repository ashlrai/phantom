import { Fragment, useLayoutEffect, type ReactNode } from 'react';
import { aggregateProviderResources } from '../../../../core/resources/provider-aggregation.js';
import { ProviderGroupsUnavailable } from './useResourceDisplayClock.js';
import type { ProviderResourceDescriptor } from '../../../../core/resources/provider-aggregation-types.js';

export interface ProviderResourceGroupsProps {
  resources: readonly ProviderResourceDescriptor[]; nowMs: number; maxAgeMs?: number;
  kind: 'bar' | 'drawer';
  classes: { group: string; account: string; note: string; cards?: string };
  /** Parent keeps ordinary rows mounted until valid grouping is ready. */
  ready: boolean;
  onReady: (mode: 1 | 2) => void;
  renderResource: (resource: ProviderResourceDescriptor) => ReactNode;
}
const LABELS: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI', devin: 'Devin', local: 'Local compute' };

/** Loaded on demand. Counts are qualitative coverage, never pooled quota or permission. */
export function ProviderResourceGroups(props: ProviderResourceGroupsProps) {
  const { resources, nowMs, maxAgeMs, kind, classes, renderResource, ready, onReady } = props;
  const view = aggregateProviderResources(resources, { nowMs, maxAgeMs });
  const valid = view.sourceState !== 'invalid';
  useLayoutEffect(() => onReady(valid ? 2 : 1), [onReady, valid]);
  if (!valid) return <ProviderGroupsUnavailable {...props} />;
  if (!ready) return null;
  return <>
    <p className={classes.note}>Provider coverage only · quotas, credit balances and currencies are not combined. Distinct provider account identities and total account coverage are unknown.</p>
    {view.providers.map(group => <details key={group.provider} className={classes.group} data-provider-group={group.provider}>
      <summary>{LABELS[group.provider] ?? group.provider} · {group.coverage.current} current readings · {group.coverage.stale} stale readings · {group.coverage.unknown} unconfirmed resources · {group.coverage.accountReferences} configured/declared references</summary>
      {group.accounts.map(account => {
        const content = account.resources.map(resource => <Fragment key={resource.resourceId}>{renderResource(resource)}</Fragment>);
        return <details key={account.key} className={classes.account}>
          <summary>{account.accountId === null ? `Unbound product · ${account.resources[0]?.label ?? 'unknown'}` : `${account.resources.every(resource => resource.resourceKind === 'declared-agent') ? 'Declared account reference' : 'Configured connection/account reference'} · ${account.accountId}`}</summary>
          {kind === 'drawer' ? <ul className={classes.cards}>{content}</ul> : content}
        </details>;
      })}
    </details>)}
  </>;
}
