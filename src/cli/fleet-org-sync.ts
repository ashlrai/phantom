/**
 * `phm fleet org-sync [--runs-dir DIR] [--json] [--apply]` — delivers pending
 * org.membership bus events recorded in an existing agents.json store.
 * Default previews and never writes; --apply replays undelivered entries in
 * revision order with their original stable event IDs. Events are planning
 * metadata, not live staffing or an execution grant. Logic lives in
 * src/core/org/agent-plane-outbox.ts; this file parses argv and renders.
 */
import {
  orgRunsRoot,
  orgStoreErrorMessage,
  parseOrgPlaneCliArgs,
} from '../core/org/agent-plane-reader.js';
import { applyOrgOutbox, previewOrgOutbox, type OutboxDeps, type OutboxEvent } from '../core/org/agent-plane-outbox.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const ORG_SYNC_USAGE = `Usage: phm fleet org-sync [--runs-dir DIR] [--json] [--apply]

Delivers pending org.membership bus events recorded in an EXISTING org/agents.json (--runs-dir,
else $ASHLR_RUNS_DIR, else ~/.ashlr-runs). Default previews and never writes or posts.
--apply replays undelivered entries in revision order with their original stable event IDs;
posted and duplicate both count as delivered, a failure stops before later revisions. Only
busDelivered flags change. Events are planning metadata, not live staffing or an execution grant.
Never initializes an org. Exit 0 on success; 1 on refusal, blocked or unknown delivery; 2 on usage errors.`;

export interface FleetOrgSyncDeps extends OutboxDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  defaultRunsRoot?: () => string;
}

const line = (event: OutboxEvent) => `  rev ${event.revision} ${event.roleId} ${event.state} ${event.id}${event.reason ? `: ${event.reason}` : ''}`;

export async function cmdFleetOrgSync(args: string[], deps: FleetOrgSyncDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => console.log(text));
  const err = deps.err ?? ((text: string) => console.error(text));
  const parsed = parseOrgPlaneCliArgs(args, { allowApply: true });
  if (parsed.kind === 'help') { out(ORG_SYNC_USAGE); return 0; }
  if (parsed.kind === 'usage') { err(ORG_SYNC_USAGE); return 2; }

  const mode = parsed.apply ? 'apply' : 'preview';
  const base = { schema: 'org.outbox.sync.v1', mode, grantsExecutionAuthority: false, liveStaffing: 'unknown' };
  let events: OutboxEvent[];
  let persisted = true, complete = true;
  try {
    const root = parsed.runsDir ?? (deps.defaultRunsRoot ?? orgRunsRoot)();
    if (parsed.apply) ({ events, persisted, complete } = applyOrgOutbox(root, deps));
    else events = previewOrgOutbox(root);
  } catch (error) {
    const reason = orgStoreErrorMessage(error, 'Org sync unavailable.');
    if (parsed.json) out(JSON.stringify({ ...base, status: 'refused', reason }));
    else err(`phm fleet org-sync: ${reason}`);
    return 1;
  }

  const ok = complete && persisted;
  const view = { ...base, status: ok ? 'ok' : 'incomplete', persisted, events };
  if (parsed.json) out(JSON.stringify(sanitizePublicJson(view), null, 2));
  else out(sanitizePublicJson([`org sync ${mode}: planning metadata only; live staffing unknown; ${events.length} event(s)`,
    ...events.map(line), ...(persisted ? [] : ['delivery flags not persisted; a retry is duplicate-safe'])].join('\n')) as string);
  return ok ? 0 : 1;
}
