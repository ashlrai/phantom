/** Opt-in cold-start diagnostics. Never include argv, config, or environment values. */
const enabled = process.env.PHM_STARTUP_TIMING === '1';

function report(event: string, module: string, durationMs: number): void {
  console.error(JSON.stringify({ scope: 'phm-startup', event, module, durationMs }));
}

/** Includes Node bootstrap and evaluation of the entry point's static import graph. */
export function reportStartupReady(): void {
  if (enabled) report('ready', 'cli', process.uptime() * 1000);
}

/** Time loading and evaluating a selected module, preserving its result and errors. */
export async function timeImport<T>(module: string, importer: () => Promise<T>): Promise<T> {
  if (!enabled) return importer();
  const start = performance.now();
  try {
    return await importer();
  } finally {
    report('import', module, performance.now() - start);
  }
}
