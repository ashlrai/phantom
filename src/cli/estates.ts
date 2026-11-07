/**
 * `phm estates` — per-repo estate card dashboard.
 *
 * Per-repo health / SLI snapshot for the entire AshlrAI fleet.
 *
 * Commands:
 *   phm estates --json             List all estate cards (portfolio view).
 *   phm estates --repo <repo-id>   Show a single estate card.
 *
 * Output:
 *   - TTY: formatted table with repo, agent, tier, CI rate, release age,
 *     security, health grade.
 *   - --json: full JSON report (EstateReport or EstateCard).
 *
 * All data is read-only metadata; never prints secrets or tokens.
 */

import { buildEstateReport, buildEstateCardReport } from '../core/estates.js';

const HELP = `Usage: phm estates [--json] [--repo <repo-id>]

Per-repo estate cards: health, CI rate, release age, open PRs, security.

  --json     Emit full JSON report (EstateReport or EstateCard).
  --repo     Show a single estate card by repo id (e.g. phantom).

Examples:
  phm estates --json
  phm estates --repo phantom --json`;

function formatTableRow(c: { id: string; name: string; agent: string; tier: string; slo: any }): string {
  const label = `${c.name} [${c.id}]`.padEnd(50);
  const s = c.slo;
  const ciVal = s.ciGreenRate;
  const ci = typeof ciVal === 'number' ? `${(ciVal * 100).toFixed(0)}%`.padEnd(6) : '-'.padEnd(6);
  const relAge = s.releaseAgeDays;
  const relAgeStr = typeof relAge === 'number' ? `${relAge}d`.padEnd(8) : '-'.padEnd(8);
  const prsVal = s.openPrCount;
  const prsStr = typeof prsVal === 'number' ? `${prsVal}`.padEnd(5) : '-'.padEnd(5);
  const sec = (s.securitySeverity as string) ?? '-'.padEnd(11);
  const grade = (s.healthGrade as string) ?? '-';
  return `${label}${ci}${relAgeStr}${prsStr}${sec}${grade}`;
}

function formatTable(cards: Array<{ id: string; name: string; agent: string; tier: string; slo: any }>): string {
  const header = 'Estate Cards'.padEnd(50) + 'CI    Release  PRs  Security  Health';
  const divider = '-'.repeat(50) + '------- -------- ----- --------- ------';
  const rows = cards.map(formatTableRow);
  return [header, divider, ...rows].join('\n');
}

export async function cmdEstates(args: string[]): Promise<number> {
  // Check for help flags explicitly (--help, -h) before treating empty args
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }

  let json = false;
  let repoId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--repo') {
      repoId = args[++i];
      if (!repoId) {
        console.error(json ? JSON.stringify({ error: 'Missing value for --repo' }) : 'Missing value for --repo');
        return 2;
      }
    } else if (arg.startsWith('-')) {
      console.error(json ? JSON.stringify({ error: 'Unknown flag: ' + arg }) : 'Unknown flag: ' + arg);
      console.error(HELP);
      return 2;
    }
  }

  try {
    if (repoId) {
      const card = buildEstateCardReport(repoId);
      if (!card) {
        const message = 'Estate card not found for repo: ' + repoId;
        console.error(json ? JSON.stringify({ error: message }) : message);
        return 1;
      }
      if (json) {
        console.log(JSON.stringify({ report: 'EstateCard' as const, card }, null, 2));
      } else {
        console.log('Estate Card: ' + card.name + ' [' + card.id + ']');
        console.log('  Agent:       ' + card.agent);
        console.log('  Tier:        ' + card.tier);
        console.log('  Runbook:     ' + card.runbook);
        console.log('  CI Rate:     ' + (card.slo.ciGreenRate !== null ? (card.slo.ciGreenRate * 100).toFixed(1) + '%' : 'unknown'));
        console.log('  Release Age: ' + (card.slo.releaseAgeDays !== null ? card.slo.releaseAgeDays + ' days' : 'unknown'));
        console.log('  Last Commit: ' + (card.slo.lastCommitDaysAgo !== null ? card.slo.lastCommitDaysAgo + ' days ago' : 'unknown'));
        console.log('  Open PRs:    ' + (card.slo.openPrCount !== null ? card.slo.openPrCount.toString() : 'unknown'));
        console.log('  Security:    ' + card.slo.securitySeverity);
        console.log('  Health:      ' + (card.slo.healthGrade ?? '-') + ' (' + (card.slo.healthScore ?? 'n/a') + ')');
        if (card.noData) {
          console.log('  (no data yet — populate mirrors and quality data)');
        }
      }
      return 0;
    }

    const report = buildEstateReport();
    if (json) {
      const jsonCards = report.cards.map(function(c) {
        return { id: c.id, name: c.name, agent: c.agent, tier: c.tier, runbook: c.runbook, slo: c.slo, generatedAt: c.generatedAt, noData: c.noData };
      });
      const output = { report: 'EstateReport' as const, generatedAt: report.generatedAt, cardCount: report.cardCount, summary: report.summary || {}, cards: jsonCards };
      console.log(JSON.stringify(output, null, 2));
    } else {
      if (report.cards.length === 0) {
        console.log('No estate cards — configure ecosystem focus to add repos.');
        return 0;
      }
      const tableCards = report.cards.map(function(c) {
        return { id: c.id, name: c.name, agent: c.agent, tier: c.tier, slo: c.slo };
      });
      console.log(formatTable(tableCards));
      if (report.summary) {
        console.log('');
        console.log('Summary: ' + report.cardCount + ' cards, ' + report.summary.cardsWithData + ' with data, ' + report.summary.cardsWithFindings + ' with security findings, ' + report.summary.cardsWithoutData + ' without data');
        if (report.summary.avgCiGreenRate !== null) {
          console.log('  Avg CI green rate: ' + (report.summary.avgCiGreenRate * 100).toFixed(1) + '%');
        }
      }
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Estate report failed';
    console.error(json ? JSON.stringify({ error: message }) : message);
    return 2;
  }
}
