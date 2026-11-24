/**
 * Pure interpretation of the `route:*` labels on an archived (recorded) issue.
 *
 * Recovered from Phantom PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886),
 * `src/core/providers/coding-cli/worker-plan.ts` `ROUTE_LABELS`, `ROUTE_BACKEND`, `routeOf`.
 * Only the label interpretation is kept; the planner's authorization, billing, account,
 * cooldown and spawn closure is not inherited.
 *
 * Deliberate differences from the source: malformed input throws a TypeError instead of
 * being filtered (so a corrupt archive cannot read as "missing"); every result is marked
 * `historical-offline` with `executionAuthority: 'none'`; `route:any` yields no backend
 * because the seat-router choice is not reproduced here.
 *
 * No filesystem, env, auth, quota, clock, or provider access. The input is never mutated.
 */

export const RECORDED_ROUTE_LABELS = Object.freeze(['route:codex', 'route:claude', 'route:grok', 'route:any'] as const);
export type RecordedRouteLabel = (typeof RECORDED_ROUTE_LABELS)[number];
export type RecordedPinnedBackend = 'codex' | 'claude' | 'grok';

/** Historical backend string per pinned label (the `route:grok` value is data only). */
const RECORDED_ROUTE_BACKEND: Readonly<Record<Exclude<RecordedRouteLabel, 'route:any'>, RecordedPinnedBackend>> =
  Object.freeze({ 'route:codex': 'codex', 'route:claude': 'claude', 'route:grok': 'grok' });

export const RECORDED_ROUTE_PROVENANCE = Object.freeze({
  pr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  sourcePath: 'src/core/providers/coding-cli/worker-plan.ts',
  symbols: Object.freeze(['ROUTE_LABELS', 'ROUTE_BACKEND', 'routeOf'] as const),
  authority: 'historical-offline' as const,
});

export interface RecordedRouteInspection {
  readonly status: 'missing' | 'ambiguous' | 'pinned' | 'any';
  /** The single recognized label for `pinned` and `any`; null otherwise. */
  readonly route: RecordedRouteLabel | null;
  /** Historical backend string, `pinned` only. */
  readonly backend: RecordedPinnedBackend | null;
  /** Every recognized occurrence in input order, duplicates included. */
  readonly matches: readonly RecordedRouteLabel[];
  /** True only for `route:any`: a recorded seat-router choice is needed, none is invented. */
  readonly seatRouterChoiceRequired: boolean;
  readonly reason: string;
  readonly provenance: typeof RECORDED_ROUTE_PROVENANCE.authority;
  readonly executionAuthority: 'none';
}

const KNOWN: ReadonlySet<string> = new Set<string>(RECORDED_ROUTE_LABELS);

/** Interpret one archived issue's labels. Exact-match only; reads its argument and nothing else. */
export function inspectRecordedRouteLabels(labels: readonly string[]): RecordedRouteInspection {
  if (!Array.isArray(labels)) throw new TypeError('recorded route labels: labels must be an array');
  const matches: RecordedRouteLabel[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    const label: unknown = labels[i];
    if (typeof label !== 'string') throw new TypeError(`recorded route labels: labels[${i}] must be a string`);
    if (KNOWN.has(label)) matches.push(label as RecordedRouteLabel);
  }
  const base = { matches, seatRouterChoiceRequired: false, provenance: 'historical-offline', executionAuthority: 'none' } as const;
  if (matches.length === 0) return { ...base, status: 'missing', route: null, backend: null, reason: 'no route label' };
  if (matches.length > 1) return { ...base, status: 'ambiguous', route: null, backend: null, reason: 'more than one route label' };
  const route = matches[0];
  if (route === 'route:any') {
    return {
      ...base, status: 'any', route, backend: null, seatRouterChoiceRequired: true,
      reason: 'route:any waits for the seat-router policy pass',
    };
  }
  return { ...base, status: 'pinned', route, backend: RECORDED_ROUTE_BACKEND[route], reason: 'label-pinned route' };
}
