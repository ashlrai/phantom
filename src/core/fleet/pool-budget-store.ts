import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectPoolBudgets, validateBudgetReading, type BudgetReading, type PoolBudgetSnapshot } from './pool-budget.js';

export function poolBudgetDirectory(): string { return join(homedir(), '.ashlr', 'fleet', 'budgets'); }

/** Immutable files avoid lost updates between concurrent manual and automatic readers. */
export async function addBudgetReadings(readings: readonly BudgetReading[], directory = poolBudgetDirectory()): Promise<void> {
  const clean = readings.map(validateBudgetReading);
  if (clean.some(r => Date.parse(r.timestamp) > Date.now())) throw new Error('Future observation');
  if (!clean.length) throw new Error('No supported budget readings found');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const temp = join(directory, `${id}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(clean) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, join(directory, `${id}.json`));
  } finally { await unlink(temp).catch(() => undefined); }
}
export async function readPoolBudgets(directory = poolBudgetDirectory(), now = new Date()): Promise<PoolBudgetSnapshot> {
  try {
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return projectPoolBudgets([], now);
      throw error;
    }
    const readings: BudgetReading[] = [];
    for (const file of files.filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).sort()) {
      const value: unknown = JSON.parse(await readFile(join(directory, file), 'utf8'));
      if (!Array.isArray(value)) throw new Error('Invalid budget ledger');
      readings.push(...value.map(validateBudgetReading));
    }
    return projectPoolBudgets(readings, now);
  } catch { return projectPoolBudgets([], now, 'unavailable'); }
}
