/** Descriptive metadata only. Commands and endpoints are never executed by the catalog. */
export type ResourceKind = 'subscription' | 'apikey' | 'local' | 'computer' | 'cloud' | 'agent';

export interface CatalogResource {
  id: string;
  kind: ResourceKind;
  displayName: string;
  planTiers: readonly string[];
  cliBinary: string | null;
  loginCheckCommand: string | null;
  keyEnvName: string | null;
  validateEndpoint: string | null;
  docsUrl: string;
  logoPath: string | null;
}

export const RESOURCE_CATALOG: readonly CatalogResource[] = [
  { id: 'codex', kind: 'subscription', displayName: 'Codex', planTiers: ['Plus', 'Pro', 'Business', 'Enterprise'], cliBinary: 'codex', loginCheckCommand: 'codex login status', keyEnvName: null, validateEndpoint: null, docsUrl: 'https://developers.openai.com/codex/', logoPath: null },
  { id: 'claude-code', kind: 'subscription', displayName: 'Claude Code', planTiers: ['Pro', 'Max', 'Team', 'Enterprise'], cliBinary: 'claude', loginCheckCommand: 'claude auth status', keyEnvName: null, validateEndpoint: null, docsUrl: 'https://code.claude.com/docs/en/overview', logoPath: null },
  { id: 'devin', kind: 'subscription', displayName: 'Devin', planTiers: ['Core', 'Team', 'Enterprise'], cliBinary: null, loginCheckCommand: null, keyEnvName: null, validateEndpoint: null, docsUrl: 'https://docs.devin.ai/', logoPath: null },
  { id: 'grok', kind: 'apikey', displayName: 'Grok / xAI', planTiers: ['API'], cliBinary: null, loginCheckCommand: null, keyEnvName: 'XAI_API_KEY', validateEndpoint: 'https://api.x.ai/v1/models', docsUrl: 'https://docs.x.ai/', logoPath: null },
  { id: 'cursor', kind: 'subscription', displayName: 'Cursor', planTiers: ['Hobby', 'Pro', 'Business', 'Enterprise'], cliBinary: 'cursor', loginCheckCommand: null, keyEnvName: null, validateEndpoint: null, docsUrl: 'https://cursor.com/docs', logoPath: null },
  { id: 'gemini', kind: 'subscription', displayName: 'Gemini CLI', planTiers: ['Free', 'Google AI Pro', 'Google AI Ultra'], cliBinary: 'gemini', loginCheckCommand: null, keyEnvName: null, validateEndpoint: null, docsUrl: 'https://geminicli.com/docs/', logoPath: null },
  { id: 'openai', kind: 'apikey', displayName: 'OpenAI', planTiers: ['API'], cliBinary: null, loginCheckCommand: null, keyEnvName: 'OPENAI_API_KEY', validateEndpoint: 'https://api.openai.com/v1/models', docsUrl: 'https://platform.openai.com/docs/', logoPath: null },
  { id: 'anthropic', kind: 'apikey', displayName: 'Anthropic', planTiers: ['API'], cliBinary: null, loginCheckCommand: null, keyEnvName: 'ANTHROPIC_API_KEY', validateEndpoint: 'https://api.anthropic.com/v1/models', docsUrl: 'https://docs.anthropic.com/', logoPath: null },
  { id: 'google', kind: 'apikey', displayName: 'Google', planTiers: ['API'], cliBinary: null, loginCheckCommand: null, keyEnvName: 'GEMINI_API_KEY', validateEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models', docsUrl: 'https://ai.google.dev/gemini-api/docs', logoPath: null },
  { id: 'omlx', kind: 'local', displayName: 'oMLX', planTiers: ['Local'], cliBinary: 'omlx', loginCheckCommand: null, keyEnvName: null, validateEndpoint: 'http://127.0.0.1:8000/v1/models', docsUrl: 'https://github.com/jundot/omlx', logoPath: null },
  { id: 'lm-studio', kind: 'local', displayName: 'LM Studio', planTiers: ['Local'], cliBinary: 'lms', loginCheckCommand: null, keyEnvName: null, validateEndpoint: 'http://127.0.0.1:1234/v1/models', docsUrl: 'https://lmstudio.ai/docs', logoPath: null },
  { id: 'ollama', kind: 'local', displayName: 'Ollama', planTiers: ['Local'], cliBinary: 'ollama', loginCheckCommand: null, keyEnvName: null, validateEndpoint: 'http://127.0.0.1:11434/api/tags', docsUrl: 'https://docs.ollama.com/', logoPath: null },
  { id: 'this-computer', kind: 'computer', displayName: 'This computer', planTiers: [], cliBinary: null, loginCheckCommand: null, keyEnvName: null, validateEndpoint: null, docsUrl: 'https://phm.dev/', logoPath: null },
  { id: 'cloud-computer', kind: 'cloud', displayName: 'Cloud computer', planTiers: [], cliBinary: null, loginCheckCommand: null, keyEnvName: null, validateEndpoint: null, docsUrl: 'https://phm.dev/', logoPath: null },
  { id: 'proactive-agents', kind: 'agent', displayName: 'Proactive agents', planTiers: [], cliBinary: null, loginCheckCommand: null, keyEnvName: null, validateEndpoint: null, docsUrl: 'https://phm.dev/', logoPath: null },
];

/**
 * Catalog rows that can take an API key into Phantom Secrets custody:
 * apikey resources carrying both a vault env NAME and a validate endpoint.
 * Metadata only -- the key value itself is handled by core/onboard.ts.
 */
export function apiKeyCatalogResources(): CatalogResource[] {
  return RESOURCE_CATALOG.filter(
    (r) => r.kind === 'apikey' && typeof r.keyEnvName === 'string' && typeof r.validateEndpoint === 'string',
  );
}
