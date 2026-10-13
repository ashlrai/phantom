import type { ProviderResourceGroupsProps } from './ProviderResourceGroups.js';
import { createElement, lazy } from 'react';

export function ProviderGroupsUnavailable({ classes }: ProviderResourceGroupsProps) {
  return createElement('p', { role: 'status', className: classes.note }, 'Provider grouping unavailable; showing resources.');
}
export const LazyProviderResourceGroups = lazy(() => import('./ProviderResourceGroups.js')
  .then(module => ({ default: module.ProviderResourceGroups }))
  .catch(() => ({ default: ProviderGroupsUnavailable })));
