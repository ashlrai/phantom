/**
 * What a lane's sandbox can do, what a job's prompt needs, and whether the two
 * fit. Pure: no I/O, no clock, no model calls.
 *
 * A lane declares each capability as true (proven), false (proven missing) or
 * null (unknown). Only a declared `false` refuses a route: unknown is shown as
 * unknown and never counted as proof either way. Needs are inferred from the
 * task text with fixed patterns; the fleet CONTEXT block and sentences that
 * forbid a tool ("do not run gh pr create") are not needs.
 *
 * A read-only gh need can be met by a gh context pack (gh-context-pack.ts);
 * a gh write (create, merge, comment) cannot.
 */
import { GH_CONTEXT_PACK_FILE, GH_CONTEXT_PACK_MARKER } from './gh-context-pack.js';

export const LANE_CAPABILITIES = ['gh', 'network', 'browser', 'local_fs_outside_worktree'] as const;
export type LaneCapability = typeof LANE_CAPABILITIES[number];
export type LaneCapabilitySet = Readonly<Record<LaneCapability, boolean | null>>;
export type LaneCapabilityOverrides = Readonly<Record<string, Partial<LaneCapabilitySet>>>;
export type RouteSkipCode = `route_skip: lane lacks ${LaneCapability}`;

/**
 * Declared facts only. claude: its worker sandbox cannot read the gh config
 * ("operation not permitted", four EMPTY runs on 2026-11-16, 19 more on
 * 2026-11-20), so gh is false until a run proves otherwise. codex-personal,
 * codex-cmp and devin run gh today. Every other value is unknown.
 */
export const DECLARED_LANE_CAPABILITIES: LaneCapabilityOverrides = Object.freeze({
  claude: Object.freeze({ gh: false }),
  'codex-personal': Object.freeze({ gh: true }),
  'codex-cmp': Object.freeze({ gh: true }),
  devin: Object.freeze({ gh: true }),
});

export function laneCapabilities(lane: string, overrides: LaneCapabilityOverrides = {}): LaneCapabilitySet {
  return { gh: null, network: null, browser: null, local_fs_outside_worktree: null, ...DECLARED_LANE_CAPABILITIES[lane], ...overrides[lane] };
}

export interface CapabilityNeed { capability: LaneCapability; access: 'read' | 'write'; evidence: string }

const FETCH = 'check|fetch|find|read(?!-only)|inspect|pull|download|get';
// "list" is a verb for PRs ("list the open PRs") but a noun next to logs ("the PR list or failed-run log").
const VERB = String.raw`\b(?:list|review|triage|scan|query|pick|take|recut|rebase|${FETCH})\b`;
const NEEDS: ReadonlyArray<{ capability: LaneCapability; access: 'read' | 'write'; pattern: RegExp }> = [
  { capability: 'gh', access: 'write', pattern: /\bgh\s+(?:pr\s+(?:create|merge|close|comment|edit|ready|review|reopen)|run\s+(?:rerun|cancel)|issue\s+(?:create|close|comment|edit)|workflow\s+run|release\s+\w+|api\s+(?:-X|--method|-f\b|-F\b))/gi },
  { capability: 'gh', access: 'read', pattern: /\bgh\s+(?:pr\s+(?:list|view|diff|checks|status|checkout)|run\s+(?:list|view|watch|download)|issue\s+(?:list|view)|search\s+\w+|api\s+(?:\/|repos\b|graphql\b|search\b|orgs\b|user\b))/gi },
  { capability: 'gh', access: 'read', pattern: new RegExp(String.raw`${VERB}[^.\n]{0,80}\bopen (?:PRs?|pull requests?)\b`, 'gi') },
  { capability: 'gh', access: 'read', pattern: new RegExp(String.raw`\b(?:${FETCH})\b[^.\n]{0,60}\b(?:failed[- ](?:runs?|jobs?)|(?:run|CI|job) logs?)\b`, 'gi') },
  { capability: 'browser', access: 'read', pattern: /\b(?:playwright|puppeteer|headless browser|in (?:a|the) browser|take (?:a )?screenshots?)\b/gi },
  { capability: 'network', access: 'read', pattern: /\b(?:curl|wget)\s+\S|\b(?:download|fetch)\b[^.\n]{0,40}https?:\/\//gi },
  { capability: 'local_fs_outside_worktree', access: 'read', pattern: /(?:^|[\s"'(`])(?:~\/|\$HOME\/|\/Users\/[^\s/]+\/)[\w.-]/gi },
];
/** A cue earlier in the same sentence turns a mention into a prohibition, not a need. */
const FORBIDS = /\b(?:do not|don't|never|must not|may not|cannot|can't|instead of|rather than|not to|without (?:calling|running|using))\b/i;

/** Needs found in the task text, one per capability and access, each with the words that showed it. */
export function inferRequiredCapabilities(prompt: string): CapabilityNeed[] {
  // The fleet CONTEXT block is supplied data (it already lists open PRs), never a request.
  const text = prompt.replace(/^## CONTEXT\b[\s\S]*?^## END CONTEXT\b.*$/m, ' ');
  const needs: CapabilityNeed[] = [];
  for (const { capability, access, pattern } of NEEDS) {
    if (needs.some(need => need.capability === capability && need.access === access)) continue;
    for (const match of text.matchAll(pattern)) {
      const sentence = text.slice(0, match.index).split(/[.;!?]\s|\n/).pop() ?? '';
      if (FORBIDS.test(sentence)) continue;
      needs.push({ capability, access, evidence: match[0].replace(/\s+/g, ' ').trim().slice(0, 80) });
      break;
    }
  }
  return needs;
}

export const routeSkipCode = (capability: LaneCapability): RouteSkipCode => `route_skip: lane lacks ${capability}`;

/** The first needed capability this lane is declared to lack, or null. A pack covers read-only gh. */
export function laneLacks(lane: string, needs: readonly CapabilityNeed[], pack = false, overrides?: LaneCapabilityOverrides): LaneCapability | null {
  const caps = laneCapabilities(lane, overrides);
  return needs.find(need => caps[need.capability] === false && !(pack && need.capability === 'gh' && need.access === 'read'))?.capability ?? null;
}

/** Can this lane take a job with these needs? `missing` lists every capability it is declared to lack. */
export function laneCanRun(lane: string, needs: readonly CapabilityNeed[], pack = false, overrides?: LaneCapabilityOverrides): { ok: boolean; missing: LaneCapability[] } {
  const caps = laneCapabilities(lane, overrides);
  const missing = [...new Set(needs.filter(need => caps[need.capability] === false && !(pack && need.capability === 'gh' && need.access === 'read')).map(need => need.capability))];
  return { ok: missing.length === 0, missing };
}

export interface RouteFitInput {
  job?: string;
  lane: string;
  prompt: string;
  /** Other lanes with capacity, best first. The first one that can take the job is `next_lane`. */
  candidates?: readonly string[];
  /** A gh context pack is attached. Default: the prompt carries the pack marker. */
  pack?: boolean;
  capabilities?: LaneCapabilityOverrides;
}

export interface RouteFit {
  schema: 'route.fit.v1';
  job: string | null;
  lane: string;
  needs: CapabilityNeed[];
  decision: 'route' | 'route_with_pack' | 'route_skip';
  code: RouteSkipCode | null;
  /** Needed capabilities the lane has not declared either way. Shown, never counted as proof. */
  unknown: LaneCapability[];
  next_lane: string | null;
  /** True when attaching a gh context pack would let this lane keep the job. */
  pack_would_fix: boolean;
  /** One plain-words sentence for people. */
  line: string;
}

/** Decide whether `lane` may take the job, and where it goes if not. */
export function fitRoute(input: RouteFitInput): RouteFit {
  const needs = inferRequiredCapabilities(input.prompt);
  const pack = input.pack ?? input.prompt.includes(GH_CONTEXT_PACK_MARKER);
  const caps = laneCapabilities(input.lane, input.capabilities);
  const base = { schema: 'route.fit.v1' as const, job: input.job ?? null, lane: input.lane, needs,
    unknown: [...new Set(needs.filter(need => caps[need.capability] === null).map(need => need.capability))] };
  const lacks = laneLacks(input.lane, needs, pack, input.capabilities);
  if (lacks === null) {
    const packed = pack && laneLacks(input.lane, needs, false, input.capabilities) !== null;
    return { ...base, decision: packed ? 'route_with_pack' : 'route', code: null, next_lane: null, pack_would_fix: false,
      line: packed ? `Lane ${input.lane} cannot use gh, so the job reads ${GH_CONTEXT_PACK_FILE} instead.`
        : base.unknown.length ? `Lane ${input.lane} takes this job; whether it can use ${base.unknown.join(', ')} is unknown.`
          : `Lane ${input.lane} can take this job.` };
  }
  const next = (input.candidates ?? []).find(lane => lane !== input.lane && laneLacks(lane, needs, pack, input.capabilities) === null) ?? null;
  const fix = !pack && laneLacks(input.lane, needs, true, input.capabilities) === null;
  return { ...base, decision: 'route_skip', code: routeSkipCode(lacks), next_lane: next, pack_would_fix: fix,
    line: `Lane ${input.lane} cannot use ${lacks}, ${next ? `so this job goes to ${next}` : 'and no other lane was offered, so this job waits'}.${fix ? ' A gh context pack would let it stay.' : ''}` };
}
