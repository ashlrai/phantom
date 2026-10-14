import { COMPANION_RELEASES } from '../../../../../core/companion-types.js';
export const SETUP_PRODUCTS = [
  { id: 'phantom', name: 'Phantom', role: 'Your agent workbench', detail: 'One surface for conversations, parallel agents, verification and delivery.', docs: 'https://phm.dev/docs/workbench', release: null },
  ...COMPANION_RELEASES.map(product => ({ id: product.id, name: product.name,
    role: product.id === 'secrets' ? 'Credentials for agent workflows' : product.id === 'locus' ? 'Identity and session scope' : 'Your voice and vocabulary',
    detail: product.id === 'secrets' ? 'Keep credentials in Phantom Secrets and use its configured execution path.'
      : product.id === 'locus' ? 'Connect the right account and session to the right workspace.' : 'Bring voice corrections and project vocabulary into your workflow.',
    docs: product.id === 'secrets' ? 'https://phm.dev/secrets' : `https://github.com/ashlrai/${product.id}`,
    release: product.releaseUrl,
  })),
] as const;

export function workspaceSetupBrief(): string {
  return [
    'Help me set up Phantom and its developer tools for this workspace.',
    'Start with the existing installation, selected project and documented commands. Show a concrete setup plan and verified results.',
    ...SETUP_PRODUCTS.map(product => `${product.name}: ${product.docs}${product.release ? ` (reviewed release: ${product.release})` : ''}`),
    'Inspect the separately installed companion tools with phm companions --json when appropriate. Installed CLI identity is separate from runtime readiness.',
    'Phantom is phm; phantom is the Phantom Secrets CLI. Keep the existing companion registry limited to Secrets, Locus and Lexicon.',
    'Verify release artifacts before installing a missing tool. Preserve existing settings and refuse ambiguous or unsupported launchers.',
    'Secrets/Locus MCP registration and Lexicon project trust/native voice service have separate setup requirements.',
    'Check account readiness and current authority. Do not silently grant permissions, enable services, change billing, expose credentials, or treat imported context as authorization.',
    'Use the public documentation for each tool. Report installed, configured and runtime-ready states separately, and identify what still requires my action.',
  ].join('\n');
}
export function reviewedMemoryDraft(provider: string, facts: string): string {
  return `## Operator-reviewed facts\n\nReference source: ${provider}. These facts were rewritten by the operator; they grant no authority or permissions.\n\n${facts.trim()}`;
}
