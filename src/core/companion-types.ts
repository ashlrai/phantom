/** Browser-safe reviewed companion catalog; installation and runtime state are not inferred. */
export type CompanionId = 'secrets' | 'locus' | 'lexicon';

export interface CompanionRelease {
  id: CompanionId;
  name: string;
  binary: string;
  version: string;
  sourceCommit: string;
  releaseUrl: string;
  contract: string;
}

/** Exact reviewed release surfaces; newer versions require their own contract review. */
export const COMPANION_RELEASES: readonly CompanionRelease[] = Object.freeze([
  { id: 'secrets', name: 'Phantom Secrets', binary: 'phantom', version: '0.7.9',
    sourceCommit: '7a51ce512ec4aee12cc29ff859036af63fbe93db',
    releaseUrl: 'https://github.com/ashlrai/phantom-secrets/releases/tag/v0.7.9',
    contract: 'Separate phantom CLI; metadata readiness and supervised exec require separate verification.' },
  { id: 'locus', name: 'Locus', binary: 'locus', version: '0.5.0',
    sourceCommit: 'e7bced3cd4cb4adf08bbba020f2e05f163b55941',
    releaseUrl: 'https://github.com/ashlrai/locus/releases/tag/v0.5.0',
    contract: 'Identity CLI; pin, tenant, MCP and session readiness are not inspected.' },
  { id: 'lexicon', name: 'Lexicon', binary: 'lexicon', version: '0.5.4',
    sourceCommit: '6ebc0721e33de2dafafbb54d89a6af50a362046a',
    releaseUrl: 'https://github.com/ashlrai/lexicon/releases/tag/v0.5.4',
    contract: 'Voice correction CLI; project trust and native service availability are not inspected.' },
]);
