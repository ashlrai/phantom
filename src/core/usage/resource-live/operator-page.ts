import type { ResourceLiveObservation, ResourceLiveSource } from './source-types.js';

export interface OperatorUsagePageReader {
  read(provider: 'claude' | 'codex-personal' | 'codex-cmp', usageUrl: string): Promise<ResourceLiveObservation | null>;
}
export const stubOperatorUsagePageReader: OperatorUsagePageReader = { read: async () => null };

export function operatorPageSources(enabled: boolean | undefined, provider: 'claude' | 'codex-personal' | 'codex-cmp',
  reader: OperatorUsagePageReader = stubOperatorUsagePageReader): ResourceLiveSource[] {
  if (enabled !== true) return [];
  return [{ tier: 'visible-window', read: async () => {
    const row = await reader.read(provider, provider === 'claude'
      ? 'https://claude.ai/settings/usage' : 'https://chatgpt.com/codex/settings/usage');
    return row ? { ...row, source: 'browser-visible', tier: 'visible-window' } : null;
  } }];
}
