import type { ProviderResourceGroupsProps } from './ProviderResourceGroups.js';
import { createElement, lazy } from 'react';

function ProviderGroupsUnavailable({ classes }: ProviderResourceGroupsProps) {
  return createElement('p', { role: 'status', className: classes.note }, 'Provider groups unavailable; account readings remain separate.');
}
export const LazyProviderResourceGroups = lazy(() => import('./ProviderResourceGroups.js')
  .then(module => ({ default: module.ProviderResourceGroups }))
  .catch(() => ({ default: ProviderGroupsUnavailable })));
