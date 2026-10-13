/**
 * `ashlr home [--json] [--hours N]` — the daily home dashboard: shipped work,
 * merged PRs, value per dollar/token/second, running now, needs you.
 * Core: src/core/home/dashboard.ts (shared with MCP `ashlr_home` and the console Home page).
 */
import { buildHomeDashboard, type HomeDashboardV1, type HomeSources } from '../core/home/dashboard.js';
import { isTty, makeColors, pad } from './ui.js';

export const HOME_USAGE = 'Usage: ashlr home [--json] [--hours <1-168>]';

const dur = (s: number | null) => (s === null ? '—' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

export function renderHome(d: HomeDashboardV1, tty = isTty()): string {
  const { bold, dim, green, yellow, cyan } = makeColors(tty);
  const L: string[] = ['', `  ${bold('Phantom · today')} ${dim(`last ${d.windowHours}h · ${new Date(d.generatedAt).toLocaleString()}`)}`, ''];
  if (d.empty) {
    L.push(`  ${dim('Nothing shipped yet in this window, and nothing needs you.')}`, `  Start autonomy: ${cyan('ashlr ecosystem up')}   ·   or give work: ${cyan('ashlr run "<goal>"')}`, '');
    return L.join('\n');
  }
  L.push(`  ${bold('Shipped')}   ${green(String(d.shipped.mergedPrs))} PRs merged${Object.keys(d.shipped.byRepo).length ? dim(`  (${Object.entries(d.shipped.byRepo).map(([r, n]) => `${r} ${n}`).join(', ')})`) : ''}`);
  for (const p of d.shipped.prs.slice(0, 8)) L.push(`    ${dim(pad(`${p.repo}#${p.number}`, 22))} ${p.title.slice(0, 70)}`);
  L.push('', `  ${bold('Spend')}     $${d.spend.costUsd.toFixed(2)} · ${d.spend.tokens.toLocaleString()} tokens · ${dur(d.spend.agentSeconds)} agent time · ${d.spend.runs} runs`);
  L.push(`  ${bold('Value')}     ${d.value.mergesPerDollar ?? '—'} merges/$ · ${d.value.mergesPerMillionTokens ?? '—'} merges/1M tok · ${dur(d.value.secondsPerMerge)} agent time/merge · ${dur(d.value.medianOpenToMergeSeconds)} median open→merge`);
  L.push('', `  ${bold('Running')}   ${d.runningNow.length ? '' : dim('nothing right now')}`);
  for (const r of d.runningNow.slice(0, 8)) L.push(`    ${pad(r.engine, 10)} ${r.goal.slice(0, 70)}`);
  L.push('', `  ${bold('Needs you')} ${d.needsYou.length ? yellow(String(d.needsYou.length)) : green('nothing')}`);
  for (const a of d.needsYou) L.push(`    ${yellow('→')} ${a.title}`, `      ${cyan(a.command)}`);
  for (const w of d.warnings) L.push(`  ${yellow('!')} ${w}`);
  L.push('');
  return L.join('\n');
}

export async function cmdHome(args: string[], sources?: HomeSources): Promise<number> {
  let json = false; let hours = 24;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--hours') { hours = Number(args[++i]); if (!Number.isInteger(hours) || hours < 1 || hours > 168) { process.stderr.write(`--hours must be a whole number 1-168\n${HOME_USAGE}\n`); return 2; } }
    else if (a === '--help' || a === '-h') { process.stdout.write(`${HOME_USAGE}\n`); return 0; }
    else { process.stderr.write(`unknown argument: ${a}\n${HOME_USAGE}\n`); return 2; }
  }
  const src = sources ?? (await import('../core/home/dashboard-sources.js')).realHomeSources();
  const d = await buildHomeDashboard(src, { windowHours: hours });
  process.stdout.write(json ? `${JSON.stringify(d, null, 2)}\n` : renderHome(d));
  return 0;
}
