/** `phantom routines` — scheduled YAML routines, learned placement runs, and the portable placement registry. */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { loadConfig } from '../core/config.js';
import { load, migrate, run as runScheduled, status, launchdPlist } from '../core/routines/index.js';
import { readRoutineLedger, runRoutine, validateRoutine, type Routine as PlacementRoutine } from '../core/routines/placement.js';
import { importRoutines, readRoutines, rebalanceSavedRoutines } from '../core/automations/routines.js';
import { readJson } from '../core/resources/grokbot/ledger.js';

const USAGE = `Usage: phantom routines <command>
  list | status | tick | migrate <id> "<cron or prompt>" | launchd [--file <yaml>]
      Scheduled YAML routines: UTC cron, cheapest eligible executor, cooldowns and daily caps.
  run <routine-id> | run <routine.json> | explain <routine-id>
      Learned placement: local oMLX by default, receipts drive escalation inside declared budgets.
  export | import <file.json> | rebalance
      Portable placement registry across provider adapters using fresh quota, health, capabilities and cost.`;

/** Scheduled routines: YAML definitions, UTC cron ticks and executor failover (src/core/routines/index.ts). */
async function schedulerCli(argv: string[], out: (line: string) => void, err: (line: string) => void): Promise<number> {
  const args = [...argv];
  const index = args.indexOf('--file');
  let file: string | undefined;
  if (index !== -1) {
    if (!args[index + 1]) { err(USAGE); return 2; }
    file = resolve(args[index + 1]!); args.splice(index, 2);
  }
  const [verb, name, text] = args;
  if (!['list', 'status', 'run', 'tick', 'migrate', 'launchd'].includes(verb!) || args.length !== (verb === 'migrate' ? 3 : verb === 'run' ? 2 : 1)) { err(USAGE); return 2; }
  try {
    if (verb === 'migrate') { await migrate(text!, name!, file); return 0; }
    if (verb === 'launchd') {
      if (!file || !import.meta.url.endsWith('.js')) throw new Error('Use the built CLI and an absolute --file path');
      out(launchdPlist(process.execPath, fileURLToPath(new URL('./index.js', import.meta.url)), file)); return 0;
    }
    const config = await load(file);
    if (verb === 'list') { out(config.routines.map(r => `${r.id}\t${r.schedule}\t${r.tier}`).join('\n')); return 0; }
    if (verb === 'status') { out(await status(config)); return 0; }
    const attempts = await runScheduled(config, verb === 'run' ? name : undefined);
    out(JSON.stringify({ attempts }));
    return verb === 'run' && !attempts.some(a => a.outcome === 'success' || a.outcome === 'submitted') ? 1 : 0;
  } catch { err('Routines operation failed. Check definitions, executor login, limits and the local lock; provider diagnostics are never printed.'); return 1; }
}

/** Learned placement: run a routine.json once through the receipt-driven placement engine (src/core/routines/placement.ts). */
async function runPlacementRoutine(file: string, out: (line: string) => void, err: (line: string) => void): Promise<number> {
  try {
    const routine = JSON.parse(await readFile(file, 'utf8')) as PlacementRoutine;
    validateRoutine(routine);
    const cfg = loadConfig();
    const receipt = await runRoutine(routine, async resource => {
      if (resource.provider === 'grok') {
        if (!resource.grokbot) throw new Error('Grok Bot commissioning required.');
        const { GrokbotLane } = await import('../core/resources/grokbot/lane.js');
        const { readJson: readBudgetJson } = await import('../core/resources/grokbot/ledger.js');
        const settings = resource.grokbot;
        const root = join(homedir(), '.ashlr', 'grokbot');
        const lane = new GrokbotLane({ stateRoot: root, secretsProject: settings.secretsProject,
          caps: { day: settings.dayCap, week: settings.weekCap }, readBudget: () => readBudgetJson(settings.budgetFile) });
        const id = randomUUID();
        const deadline = Date.now() + Math.max(1000, Math.min(routine.maxLatencyMs ?? 120000, 120000));
        const task = { schema: 'grokbot-task.v1' as const, id, kind: 'connector' as const, goal: routine.goal,
          inputs: { repo: routine.sourceRepo, model: resource.model }, budget_cap: 1,
          reply_to: join(root, 'replies', `${id}.json`), deadline: new Date(deadline).toISOString() };
        await lane.submit(task);
        while (Date.now() < deadline) {
          const result = await lane.readResult(task);
          if (result) return { outcome: result.status === 'succeeded' ? 'succeeded' : 'failed', costUsd: resource.costUsd };
          await setTimeout(1000);
        }
        throw new Error('Grok Bot result deadline exceeded.');
      }
      const { runEngineSandboxed, runApiModelSandboxed } = await import('../core/run/sandboxed-engine.js');
      const engine = { local: 'local-coder', codex: 'codex', claude: 'claude', devin: 'devin-cli' } as const;
      const selected = engine[resource.provider];
      const config = resource.provider === 'local' ? {
        ...cfg, foundry: { ...cfg.foundry, engines: { ...cfg.foundry?.engines,
          'local-coder': { id: 'local-coder', kind: 'api-model' as const, tier: 'mid' as const,
            api: { envKey: '', defaultBaseUrl: 'http://127.0.0.1:8000/v1', defaultModel: resource.model, protocol: 'openai' as const },
            capabilities: ['agent', 'edit', 'tools'] },
        } },
      } : cfg;
      const run = resource.provider === 'local' ? runApiModelSandboxed : runEngineSandboxed;
      const result = await run(selected, routine.goal, config, {
        sourceRepo: routine.sourceRepo, model: resource.model,
      });
      // Completion is not a merge; the ledger later joins authenticated inbox evidence.
      return { outcome: result.state.status === 'done' ? 'succeeded' : 'failed', costUsd: result.state.usage.estCostUsd, proposalId: result.proposalId };
    });
    out(JSON.stringify(receipt, null, 2));
    return receipt.outcome === 'failed' ? 1 : 0;
  } catch {
    err('Routine refused or failed; inspect configuration and private ledger.');
    return 1;
  }
}

function explainPlacement(id: string | undefined, out: (line: string) => void, err: (line: string) => void): number {
  try {
    if (!id) throw new Error('missing routine id');
    const rows = readRoutineLedger().filter(x => x.routineId === id);
    if (!rows.length) throw new Error('No recorded placement for routine.');
    out(JSON.stringify(rows, null, 2));
    return 0;
  } catch {
    err('Routine refused or failed; inspect configuration and private ledger.');
    return 1;
  }
}

/** Portable placement registry: import/export/rebalance across provider adapters (src/core/automations/routines.ts). */
async function registryCli(args: string[], out: (line: string) => void, err: (line: string) => void): Promise<number> {
  const [verb, file, ...extra] = args;
  if (extra.length || (verb === 'import' ? !file : file !== undefined) || !['export', 'import', 'rebalance'].includes(verb!)) {
    err('Usage: phantom routines export | import <file.json> | rebalance'); return 2;
  }
  try {
    const routines = verb === 'import' ? await importRoutines(await readJson(file!, 16_384))
      : verb === 'rebalance' ? await rebalanceSavedRoutines() : await readRoutines();
    out(JSON.stringify({ schema: 'phantom-routines.v1', routines }, null, 2)); return 0;
  } catch {
    err('Routine operation refused: check document, fresh provider evidence, and conflicting IDs. Existing data was preserved.'); return 1;
  }
}

export async function runRoutinesCli(args: string[], out: (line: string) => void = console.log, err: (line: string) => void = console.error): Promise<number> {
  const [verb] = args;
  if (!verb || verb === 'help' || args.includes('--help') || args.includes('-h')) { out(USAGE); return 0; }
  if (verb === 'run') {
    const target = args[1];
    // A .json path (or any existing file) is a placement routine; bare ids are scheduled YAML routines.
    if (target && (target.toLowerCase().endsWith('.json') || existsSync(target))) {
      if (args.length !== 2) { err(USAGE); return 2; }
      return runPlacementRoutine(target, out, err);
    }
    return schedulerCli(args, out, err);
  }
  if (verb === 'explain') {
    if (args.length !== 2) { err(USAGE); return 2; }
    return explainPlacement(args[1], out, err);
  }
  if (verb === 'export' || verb === 'import' || verb === 'rebalance') return registryCli(args, out, err);
  return schedulerCli(args, out, err);
}
