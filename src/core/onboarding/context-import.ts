/**
 * core/onboarding/context-import.ts — optional import of context/memory that
 * Claude Code, Codex and Grok already keep as local files.
 *
 * Consent-first: `discoverContextSources` only stats known paths; `previewSource`
 * reads at most PREVIEW_BYTES of a user-chosen source and redacts secret-shaped
 * text; `importSource` copies the redacted text into Phantom's context folder
 * only when called with `consent: true`. Credential files (auth.json,
 * .credentials.json, *.key) are never on the list and are refused by name.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { redactSecrets } from './resources-model.js';

export type ContextOrigin = 'claude' | 'codex' | 'grok' | 'project';

export interface ContextSource {
  id: string;
  origin: ContextOrigin;
  label: string;
  path: string;
  bytes: number;
}

export const PREVIEW_BYTES = 4096;
export const MAX_IMPORT_BYTES = 256 * 1024;

const FORBIDDEN = /(auth|credential|token|secret|\.key$|\.pem$|cookies)/i;

export function candidatePaths(home: string, cwd: string): Array<Omit<ContextSource, 'bytes'>> {
  return [
    { id: 'claude-global', origin: 'claude', label: 'Claude Code global memory (~/.claude/CLAUDE.md)', path: join(home, '.claude', 'CLAUDE.md') },
    { id: 'codex-agents', origin: 'codex', label: 'Codex global instructions (~/.codex/AGENTS.md)', path: join(home, '.codex', 'AGENTS.md') },
    { id: 'codex-config', origin: 'codex', label: 'Codex config (~/.codex/config.toml: models, MCP servers)', path: join(home, '.codex', 'config.toml') },
    { id: 'grok-instructions', origin: 'grok', label: 'Grok CLI user settings (~/.grok/user-settings.json)', path: join(home, '.grok', 'user-settings.json') },
    { id: 'project-claude', origin: 'project', label: 'This project’s CLAUDE.md', path: join(cwd, 'CLAUDE.md') },
    { id: 'project-agents', origin: 'project', label: 'This project’s AGENTS.md', path: join(cwd, 'AGENTS.md') },
  ];
}

export function discoverContextSources(home = homedir(), cwd = process.cwd()): ContextSource[] {
  const out: ContextSource[] = [];
  for (const c of candidatePaths(home, cwd)) {
    if (FORBIDDEN.test(basename(c.path))) continue;
    try {
      const st = statSync(c.path);
      if (st.isFile()) out.push({ ...c, bytes: st.size });
    } catch {
      /* absent is normal */
    }
  }
  return out;
}

function readBounded(path: string, limit: number): string {
  if (FORBIDDEN.test(basename(path))) throw new Error(`refusing to read credential-like file ${basename(path)}`);
  const buf = readFileSync(path);
  return buf.subarray(0, limit).toString('utf8');
}

export interface ContextPreview {
  source: ContextSource;
  text: string;
  truncated: boolean;
  redactions: number;
}

export function previewSource(source: ContextSource): ContextPreview {
  const raw = readBounded(source.path, PREVIEW_BYTES);
  const text = redactSecrets(raw);
  return { source, text, truncated: source.bytes > PREVIEW_BYTES, redactions: (text.match(/\[redacted\]/g) ?? []).length };
}

export function contextImportDir(home = homedir()): string {
  return join(home, '.ashlr', 'context', 'imported');
}

export function importSource(source: ContextSource, opts: { consent: boolean; home?: string }): string {
  if (opts.consent !== true) throw new Error('import requires explicit consent');
  const text = redactSecrets(readBounded(source.path, MAX_IMPORT_BYTES));
  const dir = contextImportDir(opts.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = resolve(dir, `${source.id}.md`);
  const header = `<!-- imported by phm setup from ${source.path} on ${new Date().toISOString()}; secret-shaped text redacted -->\n\n`;
  writeFileSync(dest, header + text, { mode: 0o600 });
  return dest;
}

export function isImported(source: ContextSource, home = homedir()): boolean {
  return existsSync(join(contextImportDir(home), `${source.id}.md`));
}
