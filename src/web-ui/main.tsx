import { PRODUCT_NAME } from './app/product-brand.js';
import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { autoSelectVerseMobile, isResourceConsolePath, isUniverseConsolePath, isVerseConsolePath, isVerseMobilePath } from './app/console-mode.js';
import './data/appearance-boot.js';

// The scoped console must not evaluate the general shell's observer modules.
// Verse on a phone is its own chunk: /verse/m, or /verse opened on a phone
// (which becomes /verse/m/ in place). The workbench's modules never load there.
//
// The picked app renders once its chunk is in, not through lazy()+Suspense:
// a committed Suspense fallback makes React hold the next reveal for 300 ms,
// and that throttle, not the download, was most of the gap between the
// loading line and the shell on a cold /verse load (3.29.16 measurements).
function loadApp(): Promise<ComponentType> {
  if (isResourceConsolePath()) return import('./app/ResourcePoolConsoleApp.js').then((module) => module.ResourcePoolConsoleApp);
  if (isUniverseConsolePath()) return import('./app/UniverseConsoleApp.js').then((module) => module.UniverseConsoleApp);
  if (isVerseMobilePath() || autoSelectVerseMobile()) return import('./app/VerseMobileApp.js').then((module) => module.VerseMobileApp);
  if (isVerseConsolePath()) return import('./app/VerseConsoleApp.js').then((module) => module.VerseConsoleApp);
  return import('./app/App.js').then((module) => module.App);
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element missing from index.html');
}

const root = createRoot(container);
root.render(<p role="status">{`Loading ${PRODUCT_NAME}…`}</p>);
loadApp().then(
  (App) => root.render(<StrictMode><App /></StrictMode>),
  (err: unknown) => {
    root.render(`${PRODUCT_NAME} could not load. Reload to try again.`);
    throw err;
  },
);
