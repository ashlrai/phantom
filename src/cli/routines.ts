/** Concrete routine placement; native engines retain their sandbox and admission controls. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { loadConfig } from '../core/config.js';
import { readRoutineLedger, runRoutine, validateRoutine, type Routine } from '../core/routines/index.js';

export async function runRoutinesCli(args: string[], out = console.log): Promise<number> {
  const [verb, id, extra] = args;
  if (args.includes('--help') || args.includes('-h') || verb === 'help') {
    out('Usage: phantom routines run <routine.json> | explain <routine-id>');
    return 0;
  }
  if (!id || extra || !['run', 'explain'].includes(verb!)) return 2;
  try {
    if (verb === 'explain') {
      const rows = readRoutineLedger().filter(x => x.routineId === id);
      if (!rows.length) throw new Error('No recorded placement for routine.');
      out(JSON.stringify(rows, null, 2));
      return 0;
    }
    const routine = JSON.parse(await readFile(id, 'utf8')) as Routine;
    validateRoutine(routine);
    const cfg = loadConfig();
    const receipt = await runRoutine(routine, async resource => {
      if (resource.provider === 'grok') {
        if (!resource.grokbot) throw new Error('Grok Bot commissioning required.');
        const { GrokbotLane } = await import('../core/resources/grokbot/lane.js');
        const { readJson } = await import('../core/resources/grokbot/ledger.js');
        const settings = resource.grokbot;
        const root = join(homedir(), '.ashlr', 'grokbot');
        const lane = new GrokbotLane({ stateRoot: root, secretsProject: settings.secretsProject,
          caps: { day: settings.dayCap, week: settings.weekCap }, readBudget: () => readJson(settings.budgetFile) });
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
    out('Routine refused or failed; inspect configuration and private ledger.');
    return 1;
  }
}
