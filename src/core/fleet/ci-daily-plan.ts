import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

export type WorkflowTriggerPlan = {
  file: string; name: string | null; action: 'keep' | 'change' | 'skip';
  removed: string[]; kept: string[]; added: string[]; cron: string | null;
  reason: string; before: string; after: string;
};

/** Plan trigger changes without filesystem or process effects. */
export function planWorkflow(file: string, text: string, opts: { cron: string; keepMergeGroup: boolean }): WorkflowTriggerPlan {
  const plan: WorkflowTriggerPlan = { file, name: null, action: 'keep', removed: [], kept: [], added: [], cron: null, reason: 'No triggers removed.', before: text, after: text };
  try {
    const doc = parseDocument(text);
    if (doc.errors.length) throw new Error(doc.errors.map(error => error.message).join('; '));
    if (!isMap(doc.contents)) throw new Error('Workflow must be a mapping');
    const name = doc.get('name');
    plan.name = typeof name === 'string' ? name : null;
    let triggers = doc.get('on', true);
    if (isScalar(triggers) && typeof triggers.value === 'string') {
      triggers = doc.createNode({ [triggers.value]: null });
    } else if (isSeq(triggers)) {
      const events: Record<string, null> = {};
      for (const item of triggers.items) {
        if (!isScalar(item) || typeof item.value !== 'string') throw new Error('Trigger list must contain event names');
        events[item.value] = null;
      }
      triggers = doc.createNode(events);
    }
    if (!isMap(triggers)) throw new Error('Workflow on must be an event mapping, name, or list');
    let tagsOnly = false;
    for (const pair of [...triggers.items]) {
      const event = String(isScalar(pair.key) ? pair.key.value : pair.key);
      const config = pair.value;
      const tagPush = event === 'push' && isMap(config) && config.has('tags') && !config.has('branches') && !config.has('branches-ignore');
      const remove = ['pull_request', 'pull_request_target', 'push'].includes(event) && !tagPush || event === 'merge_group' && !opts.keepMergeGroup;
      if (remove) {
        plan.removed.push(event);
        triggers.delete(event);
      } else {
        plan.kept.push(event);
        tagsOnly ||= tagPush;
      }
    }
    if (plan.removed.length && !triggers.has('schedule')) {
      triggers.set('schedule', doc.createNode([{ cron: opts.cron }]));
      plan.added.push('schedule');
    }
    const schedule = triggers.get('schedule', true);
    if (isSeq(schedule) && isMap(schedule.items[0])) {
      const cron = schedule.items[0].get('cron');
      plan.cron = typeof cron === 'string' ? cron : null;
    }
    if (plan.removed.length) {
      doc.set('on', triggers);
      plan.action = 'change';
      plan.reason = 'Remove per-PR and per-push triggers; preserve existing schedules and manual/reusable events.';
      plan.after = doc.toString({ lineWidth: 0 });
    }
    if (tagsOnly) plan.reason += ' Push on tags only is kept.';
  } catch (error) {
    plan.action = 'skip';
    plan.reason = error instanceof Error ? error.message : String(error);
    plan.after = text;
  }
  return plan;
}

// A whole-file unified hunk avoids a diff dependency and handles missing final newlines.
function patchLines(text: string, prefix: string): string {
  if (!text) return '';
  const lines = text.split('\n');
  const terminated = lines.at(-1) === '';
  if (terminated) lines.pop();
  return lines.map(line => prefix + line + '\n').join('') + (terminated ? '' : '\\ No newline at end of file\n');
}

export function planCiDaily(files: Array<{ file: string; text: string }>, opts?: { cron?: string }): { plans: WorkflowTriggerPlan[]; patch: string; summary: string; followUps: string[] } {
  const plans = [...files].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0).map(({ file, text }, index) =>
    planWorkflow(file, text, { cron: opts?.cron ?? `${3 + index % 28} 9 * * *`, keepMergeGroup: true }));
  const patch = plans.filter(plan => plan.action === 'change').map(plan => {
    const count = (text: string): number => text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
    const oldCount = count(plan.before), newCount = count(plan.after);
    const a = JSON.stringify(`a/${plan.file}`), b = JSON.stringify(`b/${plan.file}`);
    return `diff --git ${a} ${b}\n--- ${a}\n+++ ${b}\n@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@\n${patchLines(plan.before, '-')}${patchLines(plan.after, '+')}`;
  }).join('');
  return { plans, patch, summary: `${plans.length} workflows: ${plans.filter(plan => plan.action === 'change').length} change, ${plans.filter(plan => plan.action === 'keep').length} keep, ${plans.filter(plan => plan.action === 'skip').length} skip.`, followUps: [
    'Once CI stops running on pull requests, the required "Merge Gate" check never completes. Mason must stop requiring it in branch protection and configure the host-verified required check ashlr/verify as the gate (src/core/fleet/host-merge.ts and src/core/fleet/verify-check-run.ts).',
    "List current required checks for master (read only): gh api 'repos/{owner}/{repo}/branches/master/protection/required_status_checks'",
    'Review rulesets as well as branch protection. Preserved merge_group, reusable, manual, release, dispatch, tag-only push and existing schedules can still run outside the nightly window; this planner does not enforce a global once-per-day cap.',
    'Owner review is required for workflow edits; the fleet only prints a patch and cannot apply or auto-merge it.',
  ] };
}
