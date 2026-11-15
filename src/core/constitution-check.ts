import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

export interface RuleSource { path: string; text: string }
export interface RuleDiagnostic { path: string; line: number; id: string; kind: 'duplicate' | 'missing' }
export interface ConstitutionCheckResult {
  ok: boolean;
  ruleCount: number;
  referenceCount: number;
  filesChecked: number;
  diagnostics: RuleDiagnostic[];
}

// Explicit rule IDs, rather than incidental numbers or prose section names.
const IDS = /\b[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+\b/g;

/** Definitions start a Markdown heading or list item; references can occur anywhere. */
export function checkConstitutionRules(constitution: RuleSource, sources: RuleSource[]): ConstitutionCheckResult {
  const rules = new Set<string>();
  const diagnostics: RuleDiagnostic[] = [];
  let fence: string | undefined;
  for (const [index, line] of constitution.text.split(/\r?\n/).entries()) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const body = line.match(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)(.*)$/)?.[1];
    if (!body) continue;
    const id = body.match(/^(?:\*\*|`|\[)*([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+)\b/)?.[1];
    if (!id) continue;
    if (rules.has(id)) diagnostics.push({ path: constitution.path, line: index + 1, id, kind: 'duplicate' });
    rules.add(id);
  }
  let referenceCount = 0;
  for (const source of sources) {
    for (const [index, line] of source.text.split(/\r?\n/).entries()) {
      for (const match of line.matchAll(IDS)) {
        referenceCount++;
        if (!rules.has(match[0])) diagnostics.push({ path: source.path, line: index + 1, id: match[0], kind: 'missing' });
      }
    }
  }
  return { ok: diagnostics.length === 0, ruleCount: rules.size, referenceCount, filesChecked: sources.length, diagnostics };
}

const IGNORED = new Set(['.git', '.github', 'node_modules', 'dist', 'coverage', 'vendor']);
const TEXT_FILE = /\.(?:md|txt|ts|tsx|js|mjs|json|yaml|yml|hbs|mustache)$/i;

/** Read only regular text files. Never follow directory or file symlinks. */
export async function checkConstitutionRepository(root: string, paths: string[] = []): Promise<ConstitutionCheckResult> {
  const base = resolve(root);
  const constitutionPath = join(base, 'CONSTITUTION.md');
  const files = new Set<string>();
  async function walk(path: string, explicit: boolean, inScope = false): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      if (explicit) throw new Error(`Symlink input is not supported: ${relative(base, path)}`);
      return;
    }
    const name = basename(path);
    const scoped = inScope || /prompt|template/i.test(name);
    if (stat.isDirectory()) {
      if (IGNORED.has(name) || name.startsWith('.')) return;
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), explicit, scoped);
    } else if (stat.isFile() && path !== constitutionPath && TEXT_FILE.test(name) && (explicit || scoped) && !/\.(?:test|spec)\.[^.]+$/.test(name)) {
      files.add(path);
    }
  }
  const constitution = await readFile(constitutionPath, 'utf8');
  for (const path of paths.length ? paths : ['.']) await walk(resolve(base, path), paths.length > 0);
  const sources: RuleSource[] = [];
  for (const path of [...files].sort()) sources.push({ path: relative(base, path), text: await readFile(path, 'utf8') });
  return checkConstitutionRules({ path: 'CONSTITUTION.md', text: constitution }, sources);
}
