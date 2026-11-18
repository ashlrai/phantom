import { APP_ACTIONS, runAppsControl, type AppsControlDeps, type AppsRequest } from '../core/apps-control.js';
import { formatMacApps, readMacApps } from '../core/apps-known.js';
export { parseAllowlist, readAllowlist } from '../core/apps-control.js';
export type { AllowedApp, AllowlistRead, AppsControlDeps, AppsFeedEntry, AppsOutcome } from '../core/apps-control.js';

const usage = `Usage: phm apps [--json]
       phm apps open|focus|status <app> [--json]
       phm apps quit <app> [--json]
       phm apps list [--json]
       phm apps request open|quit|focus <app> [--json]
  phm apps shows Phantom, Claude, Codex, ChatGPT, Cursor, Grok and Safari: installed,
  running, frontmost and memory. Anything it cannot read says unknown, with the reason.
  open starts or raises a known app; focus raises a running one. Phantom never quits
  your apps: only Safari, its own browser, can be quit.
  list and other app names use ~/.ashlr/apps-allow.json (empty by default); an entry
  there narrows a known app's actions. Requests go to needs-you without acting.
  Every action is logged to the feed. Unsaved work blocks quitting.
  Exit: 0 done, 1 refused or failed, 2 usage, 3 routed to needs-you.`;

export async function cmdApps(args: string[], deps: AppsControlDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  const json = args.includes('--json');
  const rest = args.filter((a, i) => !(a === '--json' && args.indexOf('--json') === i));
  if (rest.length === 0) {
    const report = await readMacApps({ probe: deps.probe, home: deps.home });
    out(json ? JSON.stringify(report) : formatMacApps(report));
    return 0;
  }
  const request = rest[0] === 'request';
  if (request) rest.shift();
  const [action, app] = rest;
  if (!action || (action !== 'list' && !APP_ACTIONS.some(a => a === action)) ||
    (action === 'list' ? rest.length !== 1 || request : rest.length !== 2 || !app || app.startsWith('-') || /\p{Cc}/u.test(app) || app.length > 200) ||
    (request && action === 'status')) {
    process.stderr.write(`${usage}\n`); return 2;
  }
  const result = await runAppsControl({ action, app, request } as AppsRequest, deps);
  out(json ? JSON.stringify(result.report) : result.text);
  return result.exit;
}
