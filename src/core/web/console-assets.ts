/**
 * Resolve built web console assets (`next/index.html`) across compiled builds,
 * explicit `ASHLR_WEB_PUBLIC` overrides, and source checkouts (`npm run dev`).
 *
 * Vite writes the React console into `<repo>/dist/core/web/public/next/`. When
 * running from `<repo>/src/core/web/server.ts`, the sibling `public/` holds
 * only the legacy `/` files, so without falling back to the checkout's own
 * `dist/core/web/public/`, `/verse/`, `/app/`, `/next/` and `/verse/m/` 404
 * even after `npm run build` or `npm run build:web`.
 *
 * Security: `ASHLR_WEB_PUBLIC` is always authoritative (never falls back);
 * source-dist fallback rejects symlinks and realpath escapes; 503 copy never
 * includes filesystem paths or tokens.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ConsoleAssetsSource = 'override' | 'sibling' | 'source-dist';

export interface ConsoleAssetsStatus {
  ready: boolean;
  source: ConsoleAssetsSource | null;
  sourceCheckout: boolean;
  dirs: string[];
  fix: string | null;
}

export interface ResolveConsoleAssetsOptions {
  primaryDir?: string;
  modulePath?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_MODULE_PATH = fileURLToPath(import.meta.url);

function isContainedPath(child: string, parent: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

/** Verify `rootDir/next/index.html` is a contained, non-symlink regular file. */
function hasRegularConsoleEntry(rootDir: string, containingRoot?: string): boolean {
  try {
    const rootStat = lstatSync(rootDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
    const realRoot = realpathSync(rootDir);
    if (containingRoot !== undefined && !isContainedPath(realRoot, realpathSync(containingRoot))) {
      return false;
    }

    const nextDir = join(rootDir, 'next');
    const nextStat = lstatSync(nextDir);
    if (nextStat.isSymbolicLink() || !nextStat.isDirectory()) return false;
    if (!isContainedPath(realpathSync(nextDir), realRoot)) return false;

    const entry = join(nextDir, 'index.html');
    const entryStat = lstatSync(entry);
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) return false;
    return isContainedPath(realpathSync(entry), realRoot);
  } catch {
    return false;
  }
}

export function inspectConsoleAssets(opts: ResolveConsoleAssetsOptions = {}): ConsoleAssetsStatus {
  const env = opts.env ?? process.env;
  const override = env.ASHLR_WEB_PUBLIC;
  const modulePath = resolve(opts.modulePath ?? DEFAULT_MODULE_PATH);
  const webDir = dirname(modulePath);
  const coreDir = dirname(webDir);
  const rootKindDir = dirname(coreDir);
  const sourceCheckout = basename(webDir) === 'web'
    && basename(coreDir) === 'core'
    && basename(rootKindDir) === 'src';

  if (override) {
    const primary = opts.primaryDir ?? override;
    const ready = hasRegularConsoleEntry(primary);
    return {
      ready,
      source: ready ? 'override' : null,
      sourceCheckout,
      dirs: [primary],
      fix: ready
        ? null
        : 'Build the web console with `npm run build:web` (or `npm run build`), or check ASHLR_WEB_PUBLIC.',
    };
  }

  const primary = opts.primaryDir ?? join(webDir, 'public');
  if (hasRegularConsoleEntry(primary)) {
    return { ready: true, source: 'sibling', sourceCheckout, dirs: [primary], fix: null };
  }

  if (sourceCheckout) {
    const repoRoot = dirname(rootKindDir);
    const distPublic = join(repoRoot, 'dist', 'core', 'web', 'public');
    if (distPublic !== primary && hasRegularConsoleEntry(distPublic, repoRoot)) {
      return { ready: true, source: 'source-dist', sourceCheckout: true, dirs: [primary, distPublic], fix: null };
    }
    return {
      ready: false,
      source: null,
      sourceCheckout: true,
      dirs: [primary],
      fix: 'Run `npm run build:web` (or `npm run build`) from the repository root, then reload.',
    };
  }

  return {
    ready: false,
    source: null,
    sourceCheckout: false,
    dirs: [primary],
    fix: 'Reinstall @ashlr/phantom or rebuild the web console with `npm run build:web`.',
  };
}

/** Plain-text 503 guidance when a console shell route is requested before build. */
export function missingConsoleAssetsResponseBody(status: ConsoleAssetsStatus): string {
  if (status.sourceCheckout && !status.fix?.includes('ASHLR_WEB_PUBLIC')) {
    return [
      'Phantom web console UI is not built yet.',
      '',
      'Run from the repository root, then reload this page:',
      '  npm run build:web',
      '',
      '(Or run `npm run build` for the full CLI and web console build.)',
      '',
    ].join('\n');
  }
  return [
    'Phantom web console assets are unavailable (missing next/index.html).',
    status.fix ?? 'Reinstall @ashlr/phantom or rebuild the web console with `npm run build:web`.',
    '',
  ].join('\n');
}
