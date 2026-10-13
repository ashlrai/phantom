/**
 * Versioned constitution (the AGENTS.md agents follow). Every save snapshots
 * the previous text to ~/.ashlr/constitution/versions/<id>.md (0600) with an
 * index, so any edit can be reverted. Target: $ASHLR_CONSTITUTION, else the
 * hub repo's AGENTS.md under the ecosystem workspace.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultEcosystemWorkspace } from '../ecosystem/onboard.js';

export function constitutionPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['ASHLR_CONSTITUTION'] || join(defaultEcosystemWorkspace(env), 'phantom', 'AGENTS.md');
}
export function versionsDir(home = homedir()): string { return join(home, '.ashlr', 'constitution', 'versions'); }

export interface ConstitutionVersion { id: string; at: string; bytes: number; note: string }

function readNotes(dir: string): Record<string, string> {
  try { return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Record<string, string>; } catch { return {}; }
}

export function listVersions(dir = versionsDir()): ConstitutionVersion[] {
  if (!existsSync(dir)) return [];
  const notes = readNotes(dir);
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse().map((f) => {
    const id = f.slice(0, -3);
    return { id, at: new Date(Number(id.split('-')[0])).toISOString(), bytes: statSync(join(dir, f)).size, note: notes[id] ?? '' };
  });
}

/** Save new text; snapshots the current text first. Returns the snapshot id, or 'unchanged'. */
export function saveConstitution(text: string, note: string, path = constitutionPath(), dir = versionsDir(), now = Date.now()): string {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current === text) return 'unchanged';
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${now}-${Math.random().toString(16).slice(2, 8)}`;
  const file = join(dir, `${id}.md`);
  writeFileSync(file, current, { mode: 0o600 }); chmodSync(file, 0o600);
  const notes = readNotes(dir); notes[id] = note || 'before edit';
  writeFileSync(join(dir, 'index.json'), JSON.stringify(notes, null, 2), { mode: 0o600 });
  writeFileSync(path, text);
  return id;
}

export function revertConstitution(id: string, path = constitutionPath(), dir = versionsDir(), now = Date.now()): string {
  if (!/^\d+-[0-9a-f]{1,8}$/.test(id)) throw new Error(`not a version id: ${id} (see \`ashlr settings --json\` constitution.versions)`);
  const file = join(dir, `${id}.md`);
  if (!existsSync(file)) throw new Error(`no version ${id}; list them with \`ashlr settings --json\``);
  return saveConstitution(readFileSync(file, 'utf8'), `revert to ${id}`, path, dir, now);
}
