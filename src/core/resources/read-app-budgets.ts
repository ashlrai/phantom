import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectAppBudgets, type AppBudgets } from './app-budgets.js';
export async function readAppBudgets(): Promise<AppBudgets> {
  try { return projectAppBudgets(JSON.parse(await readFile(join(homedir(), '.ashlr-runs/queue/budget-overrides.json'), 'utf8'))); }
  catch { return projectAppBudgets(null); }
}
