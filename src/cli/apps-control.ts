import { APP_ACTIONS, runAppsControl, type AppsControlDeps, type AppsRequest } from '../core/apps-control.js';
export { parseAllowlist, readAllowlist } from '../core/apps-control.js';
export type { AllowedApp, AllowlistRead, AppsControlDeps, AppsFeedEntry, AppsOutcome } from '../core/apps-control.js';

const usage = `Usage: phm apps list [--json]
       phm apps open|quit|focus|status <app> [--json]
       phm apps request open|quit|focus <app> [--json]
  Manage desktop apps named in ~/.ashlr/apps-allow.json (empty by default).
  Per-app actions and mode apply to every caller. Requests go to needs-you without acting.
  Every action is logged to the feed. Unsaved work blocks quitting.
  Exit: 0 done, 1 refused or failed, 2 usage, 3 routed to needs-you.`;

export async function cmdApps(args: string[], deps: AppsControlDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  const json = args.includes('--json');
  const rest = args.filter((a, i) => !(a === '--json' && args.indexOf('--json') === i));
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
