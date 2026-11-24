import { formatAppActions, readAppActions, type AppActionsDeps } from '../core/apps-actions.js';
import { APP_ACTIONS, runAppsControl, type AppsControlDeps, type AppsRequest } from '../core/apps-control.js';
import { MEMORY_PRESSURES, formatAppsSuggest, formatMacApps, readMacApps, suggestApps, type MemoryPressureInput } from '../core/apps-known.js';
export { parseAllowlist, readAllowlist } from '../core/apps-control.js';
export type { AllowedApp, AllowlistRead, AppsControlDeps, AppsFeedEntry, AppsOutcome } from '../core/apps-control.js';

const usage = `Usage: phm apps [status] [--json]
       phm apps open|focus|status <app> [--json]
       phm apps quit|restart <app> [--json]
       phm apps open|focus|quit|restart <app> --dry-run [--json]
       phm apps suggest [--pressure normal|warning|critical] [--need-mb <n>] [--json]
       phm apps list [--json]
       phm apps log [--limit <n>] [--json]
       phm apps request open|quit|focus <app> [--json]
  phm apps shows Phantom, Claude, Codex, ChatGPT, Cursor, Grok, Devin and Safari: installed,
  running, frontmost, pid and memory. Anything it cannot read says unknown, with the reason.
  open starts or raises a known app; focus raises a running one. Phantom never quits
  your apps or Chrome: only Safari, its own browser, can be quit. If quitting needs a
  macOS permission, the answer is needs_permission with the System Settings path.
  quit and restart refuse the app in front. A quit that has not closed the app within
  10 s answers unknown. --dry-run checks every rule and prints the exact command; it
  runs and logs nothing.
  suggest lists the idle apps that would free the most memory. It never quits anything.
  list and other app names use ~/.ashlr/apps-allow.json (empty by default); an entry
  there narrows a known app's actions. Requests go to needs-you without acting.
  Every action is logged to the feed. Unsaved work blocks quitting.
  log lists every open, focus, quit and restart on record in the feed, newest first,
  with its outcome (50 unless --limit, at most 200). It only reads; exit 1 when the
  feed cannot be read.
  Exit: 0 done, 1 refused or failed, 2 usage, 3 routed to needs-you.`;

export async function cmdApps(args: string[], deps: AppsControlDeps & AppActionsDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const rest = args.filter((a, i) => !((a === '--json' || a === '--dry-run') && args.indexOf(a) === i));
  if (rest[0] === 'suggest') {
    const input: { pressure?: MemoryPressureInput; needMb?: number } = {};
    for (let i = 1; i < rest.length; i += 2) {
      const value = rest[i + 1];
      if (rest[i] === '--pressure' && input.pressure === undefined && MEMORY_PRESSURES.some(p => p === value)) input.pressure = value as MemoryPressureInput;
      else if (rest[i] === '--need-mb' && input.needMb === undefined && /^[1-9]\d{0,6}$/.test(value ?? '')) input.needMb = Number(value);
      else { process.stderr.write(`${usage}\n`); return 2; }
    }
    const report = suggestApps(await readMacApps({ probe: deps.probe, home: deps.home }), input);
    out(json ? JSON.stringify(report) : formatAppsSuggest(report));
    return 0;
  }
  if (rest[0] === 'log') {
    const limit = rest.length === 3 && rest[1] === '--limit' && /^[1-9]\d{0,2}$/.test(rest[2] ?? '') ? Number(rest[2]) : undefined;
    if (dryRun || (rest.length !== 1 && limit === undefined)) { process.stderr.write(`${usage}\n`); return 2; }
    const report = readAppActions(deps, limit);
    out(json ? JSON.stringify(report) : formatAppActions(report));
    return report.total === null ? 1 : 0;
  }
  if (rest.length === 0 || (rest.length === 1 && rest[0] === 'status')) {
    const report = await readMacApps({ probe: deps.probe, home: deps.home });
    out(json ? JSON.stringify(report) : formatMacApps(report));
    return 0;
  }
  const request = rest[0] === 'request';
  if (request) rest.shift();
  const [action, app] = rest;
  if (!action || (action !== 'list' && !APP_ACTIONS.some(a => a === action)) ||
    (action === 'list' ? rest.length !== 1 || request : rest.length !== 2 || !app || app.startsWith('-') || /\p{Cc}/u.test(app) || app.length > 200) ||
    (request && action === 'status') || (dryRun && (request || action === 'list' || action === 'status'))) {
    process.stderr.write(`${usage}\n`); return 2;
  }
  const result = await runAppsControl({ action, app, request, ...(dryRun ? { dryRun } : {}) } as AppsRequest, deps);
  out(json ? JSON.stringify(result.report) : result.text);
  return result.exit;
}
