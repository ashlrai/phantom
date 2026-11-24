/**
 * Recut cycle plan: which recut areas should get a job this cycle, and the task line each prompt needs.
 *
 * The recut generator (outside this repo; see BRIDGE_NOTES.md) writes one RQ-PHX-RECUT<AREA>C<n> job per
 * area each cycle. Most ended EMPTY ("no eligible PR"). Before it writes one, each area must pass:
 *   1. the recut gate (`shouldEmitRecut`): yield stop list, empty streak, and a live stop-file row;
 *   2. at least one eligible PR in the area, counted from the list the recut worker scans: open
 *      conflicting `bridge: RQ-*` PRs from `phm fleet dirty-landed`, kept only when `recutDropJob`
 *      accepts them (the same filter `phm fleet recut-sweep` applies) and a remaining path is in the area.
 * An unreadable PR list is unknown, never zero: the area then follows the gate alone.
 *
 * Every emitted prompt must start with the standard task line, `<id> (P1, pool=<lane>, tier=<tier>,
 * repo=<repo>): <task>`, because the fleet's launch precheck and stop list only look for `<id> (`.
 * Everything here is pure; `src/cli/recut-check.ts` does the reading.
 */
import type { DirtyLandedPr } from './dirty-landed-inspect.js';
import { recutDropJob } from './recut-drop-body.js';
import { AREA_PATHS, type RecutGateCode, type RecutGateDecision } from './recut-gate.js';

export const RECUT_PLAN_SCHEMA = 'recut.plan.v1';

export interface RecutTaskLineInput { id: string; lane: string; tier: string; repo: string; task: string; priority?: string }

const ID = /^[A-Z0-9][A-Z0-9-]{2,79}$/;
const ATTR = /^[A-Za-z0-9][\w.@/-]{0,63}$/;
/** The precheck reads a task of at least 16 characters after the colon. */
const MIN_TASK = 16;

/** `<id> (P1, pool=<lane>, tier=<tier>, repo=<repo>): <task>` on one line; null when a field would break the line. */
export function recutTaskLine(input: RecutTaskLineInput): string | null {
  const priority = input.priority ?? 'P1';
  const task = input.task.replace(/\s+/g, ' ').trim();
  if (!ID.test(input.id) || !/^P[0-9]$/.test(priority) || task.length < MIN_TASK) return null;
  if (![input.lane, input.tier, input.repo].every(value => ATTR.test(value))) return null;
  return `${input.id} (${priority}, pool=${input.lane}, tier=${input.tier}, repo=${input.repo}): ${task}`;
}

/** The task a prompt states: its first non-blank line without leading `#` marks or a `Goal:` label. */
export function promptTask(prompt: string): string | null {
  const first = prompt.split(/\r?\n/).find(line => line.trim() !== '');
  const task = first?.replace(/^\s*#+\s*/, '').replace(/^goal:\s*/i, '').trim();
  return task ? task : null;
}

/**
 * The prompt with `line` as its first non-blank line; the rest stays byte for byte. A prompt whose first
 * non-blank line already starts with `<id> (` is returned as it is, so wrapping twice changes nothing.
 */
export function withTaskLine(prompt: string, line: string, id: string): string {
  const first = prompt.split(/\r?\n/).find(text => text.trim() !== '');
  if (first?.startsWith(`${id} (`)) return prompt;
  return `${line}\n\n${prompt.replace(/^(?:[ \t]*\r?\n)+/, '')}`;
}

const inArea = (path: string, area: string): boolean => {
  const roots = AREA_PATHS[area];
  return !roots?.length || roots.some(root => path === root || path.startsWith(`${root}/`));
};

/** Numbers of the PRs a recut job in `area` could land: ones the recut sweep would write, touching the area. */
export function eligibleRecutPrs(prs: readonly DirtyLandedPr[], area: string, now: number): number[] {
  return prs.filter(pr => !('reason' in recutDropJob(pr, now)) && pr.remainingPaths.some(path => inArea(path, area)))
    .map(pr => pr.number).sort((a, b) => a - b);
}

export type RecutPlanCode = RecutGateCode | 'no-eligible-pr';
export interface RecutPlanArea {
  area: string; family: string; emit: boolean; code: RecutPlanCode; reason: string;
  /** Eligible PR count; null when the PR list is unknown. */
  eligible: number | null;
  prs: number[] | null;
}

/** What the PR list read gave: the PRs and whether the read covered every open PR. Null prs is unknown. */
export interface RecutPrList { prs: readonly DirtyLandedPr[] | null; complete: boolean }

/** One area's verdict. The gate decides first; a passing area still needs an eligible PR when the list is known. */
export function planRecutArea(area: string, family: string, gate: RecutGateDecision, list: RecutPrList, now: number): RecutPlanArea {
  const prs = list.prs ? eligibleRecutPrs(list.prs, area, now) : null;
  const eligible = prs ? prs.length : null;
  const row = { area: area.toLowerCase(), family, eligible, prs };
  if (!gate.emit) return { ...row, emit: false, code: gate.code, reason: gate.reason };
  if (prs === null) return { ...row, emit: true, code: gate.code, reason: `eligible PRs unknown; ${gate.reason}` };
  // A partial list can miss the one eligible PR, so zero from it is unknown, not zero.
  if (prs.length === 0 && !list.complete) {
    return { ...row, eligible: null, prs: null, emit: true, code: gate.code, reason: `eligible PRs unknown (the PR list was cut short); ${gate.reason}` };
  }
  if (prs.length === 0) return { ...row, emit: false, code: 'no-eligible-pr', reason: `no eligible PR touches ${row.area}` };
  return { ...row, emit: true, code: gate.code, reason: `${prs.length} eligible PR${prs.length === 1 ? '' : 's'}; ${gate.reason}` };
}
