/**
 * Built-in self-improvement backlog for Phantom (3.11 cloud lane).
 *
 * Each item is a COMPLETE brief for a Claude Code cloud session working in
 * ashlrai/phantom. The delivery contract (branch, draft PR, report block)
 * is appended by delivery-contract.ts — do not repeat it here. Items are
 * real gaps verified against master ea73790 (3.29.15, 2026-10-15), highest
 * leverage first. Operator and Leader items are added at runtime in
 * <cloudHome>/backlog.json.
 *
 * KEEP IT CURRENT: a stale item costs a whole cloud session that ends
 * "no-change". On 2026-10-15, 13 of the 14 items written for 3.10.1 were
 * already done on master (four of them confirmed by cloud sessions:
 * phantom #761, #762, #763 no-change and #766 partial), so they were
 * retired. Re-verify an item against master before adding it here.
 */
import type { CloudBacklogItem } from './types.js';

const REPO_NOTES = [
  'Repo: TypeScript (Node 22+/Bun), `npm ci` then verify with `npx tsc --noEmit -p tsconfig.json`,',
  '`npx tsc --noEmit -p src/web-ui/tsconfig.json`, `npx eslint <changed files>`, and the relevant',
  'tests: backend `npx vitest run <test files>`, web `npx vitest run --config vitest.config.web.ts <paths>`.',
  'Tests must stay HOME-isolated (never write a real ~/.ashlr). Never make paid model calls in tests.',
  'Some suites are macOS-only (sandbox-exec, custody, launchd); on Linux skip ones you did not touch.',
  'Keep changes focused; add a regression test for every behaviour change; write clear WHY comments.',
].join(' ');

const item = (id: string, priority: 1 | 2 | 3, area: string, title: string, task: string): CloudBacklogItem =>
  Object.freeze({ id, priority, area, title, prompt: `${task}\n\n${REPO_NOTES}` });

export const BUILTIN_IMPROVEMENT_BACKLOG: readonly CloudBacklogItem[] = Object.freeze([
  item('server-slot-plurals', 2, 'ux', 'Pluralise runtime slot counts on the server',
    'Server reasons still print "N slot(s)" instead of a plural sentence: src/core/daemon/loop.ts (fleetConcurrency "is below the runtime\'s N slot(s)"), src/core/daemon/local-fleet.ts (llama-server and operator-cap reasons), src/core/fleet/tick-hooks-live.ts (llama-server detail) and src/core/fabric/resource-monitor.ts (llama-server reason). Write "1 slot" / "2 slots" at the source with one small shared helper (dispatch-router.ts already has countOf for its own reasons; reuse or move it rather than adding a second one). Keep machine-readable fields unchanged. Leave the web laneReasonText rewrite in src/web-ui/routes/verse/fleet/why-seat-model.ts in place: older daemons and the runtime journal still carry the old wording. Update CLI/test expectations that pin the old strings.'),
  item('cloud-seat-platform-wording', 3, 'ux', 'Stop saying "on this Mac" when the Claude cloud seat is missing on Linux or Windows',
    'SEAT_NOT_READY_REASON in src/core/cloud/launcher.ts is "The Claude seat isn\'t set up on this Mac.", and the web copies the same sentence (src/web-ui/routes/verse/cloud/cloud-model.ts SEAT_NOT_READY, src/web-ui/routes/verse/resources/CloudCredits.tsx). `phm cloud launch` prints it on Linux too. Make the server sentence platform-neutral ("on this computer") or platform-aware, keep the web fallback in step with it, and update the tests that pin the old sentence (cloud-model.test.ts, CloudCard.test.tsx, ResourcesDrawer.test.tsx and any backend cloud tests).'),
]);
