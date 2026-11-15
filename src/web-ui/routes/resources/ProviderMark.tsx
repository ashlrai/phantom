import type { ProviderId } from '../../../core/fabric/provider-cards.js';
import styles from './ProviderCards.module.css';

/**
 * Monograms, not vendor logos: OpenAI, Anthropic, Cognition and xAI marks are
 * trademarked and carry no licence that fits this repo (see
 * desktop/PROVIDER-MARKS-LICENSE.txt). The local chip is drawn in-repo (MIT).
 */
const MONOGRAM: Record<ProviderId | 'local', string> = { openai: 'O', anthropic: 'A', cognition: 'D', xai: 'x', local: '' };

export function ProviderMark({ provider, label }: { provider: ProviderId | 'local'; label: string }) {
  return <span className={styles.mark} data-provider={provider} role="img" aria-label={`${label} mark`}>
    {provider === 'local'
      ? <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 1v3M10 1v3M6 12v3M10 12v3M1 6h3M1 10h3M12 6h3M12 10h3" stroke="currentColor" strokeWidth="1.2" /></svg>
      : <span aria-hidden="true">{MONOGRAM[provider]}</span>}
  </span>;
}
