import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlannerSlate, type Slate } from './planner-slate-write.js';

export const PLANNER_SLATE_PRESETS = ['codex-personal', 'claude'] as const;
export type PlannerPresetId = typeof PLANNER_SLATE_PRESETS[number];
interface PresetContext { home: string; runsRoot: string; exists?: (path: string) => boolean }

export function resolvePlannerPreset(id: PlannerPresetId, { home, runsRoot, exists = existsSync }: PresetContext) {
  const paths = id === 'codex-personal'
    ? ['/opt/homebrew/bin/codex', join(home, '.local', 'bin', 'codex'), '/usr/local/bin/codex']
    : [join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  const binary = paths.find(exists) ?? null;
  const dropDir = id === 'codex-personal' ? join(home, 'Projects', 'ashlrai', '.orch-drop', 'sol')
    : join(runsRoot, 'leader', 'drop', 'claude');
  const argv = binary === null ? [] : id === 'codex-personal'
    ? ['/usr/bin/env', 'CODEX_HOME=' + join(home, '.codex-2'), binary, 'exec', '-m', 'gpt-6.1-sol', '--sandbox', 'danger-full-access', '--skip-git-repo-check', '-C', dropDir, '-']
    : ['/bin/sh', '-c', 'cd "$0" && exec "$1" -p --model claude-fable-5-1 --dangerously-skip-permissions --add-dir "$2"', dropDir, binary, join(home, 'Projects', 'ashlrai', 'phantom')];
  return { id, provider: id, available: binary !== null, binary, dropDir, argv };
}

/** Invalid declarations throw before any filesystem mutation. */
export function composePlannerSlate(ids: readonly string[], promptPath: string, ctx: PresetContext): Slate | { error: 'unavailable'; preset: string } {
  if (ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length ||
      ids.some(id => !PLANNER_SLATE_PRESETS.includes(id as PlannerPresetId))) throw new Error('invalid presets');
  const candidates = [];
  for (const id of ids) {
    const preset = resolvePlannerPreset(id as PlannerPresetId, ctx);
    if (!preset.available) return { error: 'unavailable', preset: id };
    candidates.push({ provider: preset.provider, argv: preset.argv });
  }
  const slate = parsePlannerSlate(Buffer.from(JSON.stringify({ v: 1, candidates, promptPath })));
  if (!slate) throw new Error('invalid promptPath or preset paths');
  return slate;
}

export function plannerBriefPaths(runsRoot: string): string[] {
  return [join(runsRoot, 'queue', 'planner-brief.prompt'), join(runsRoot, 'ORCH-sol.prompt'), join(runsRoot, 'ORCH-claude.prompt')];
}
export function defaultPlannerBriefPath(runsRoot: string, exists: (path: string) => boolean = existsSync): string | null {
  return plannerBriefPaths(runsRoot).find(exists) ?? null;
}
export function briefCandidates(runsRoot: string, stat: (path: string) => { mtimeMs: number; isFile(): boolean }) {
  return plannerBriefPaths(runsRoot).map(path => {
    try {
      const info = stat(path);
      return { path, exists: info.isFile(), ageSeconds: info.isFile() ? Math.max(0, (Date.now() - info.mtimeMs) / 1000) : null };
    } catch { return { path, exists: false, ageSeconds: null }; }
  });
}
