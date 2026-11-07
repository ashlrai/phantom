/**
 * routes/verse/shell/section-modules.ts — every `sections/*Section.tsx`, lazily
 * (unit C1).
 *
 * Which sections exist is a static list (SECTION_MODULE_NAMES; the test beside
 * this file pins it to the directory), so the framework-free ui store can ask
 * "has Command landed?" (for the first-launch-of-the-day rule) without
 * importing the shell component. Keys are `./sections/<Module>.tsx` — relative
 * to routes/verse, the form VerseApp and VerseConsoleApp's first-paint preload
 * have always used.
 *
 * Chat, the section a cold load opens on, is imported directly. Every other
 * section goes through shell/section-modules-rest.ts, the glob, loaded on first
 * use: its import() thunks and preload lists are ~6 KB the chat's first paint
 * does not need. A cold load that opens on another section pays one small
 * chunk in front of it, in parallel with the session probe.
 */
type Importer = () => Promise<unknown>;

/** Every section module, by name. */
export const SECTION_MODULE_NAMES = [
  'AgentsSection',
  'AppsSection',
  'AutomationsSection',
  'AutonomySection',
  'ChatSection',
  'CommandSection',
  'FleetSection',
  'GrowthSection',
  'LiveStatusSection',
  'McpSection',
  'MindSection',
  'OpsSection',
  'PlaybooksSection',
  'SettingsSection',
  'UsageSection',
  'WikiSection',
] as const;

const loadRest = () => import('./section-modules-rest.js');

export const SECTION_MODULES: Record<string, Importer> = Object.fromEntries(
  SECTION_MODULE_NAMES.map((name): [string, Importer] => {
    const key = `./sections/${name}.tsx`;
    if (name === 'ChatSection') return [key, () => import('../sections/ChatSection.js')];
    return [key, () => loadRest().then((rest) => rest.REST_SECTION_MODULES[key]!())];
  }),
);

/** The importer for one module name (`ChatSection`), or undefined when it has not landed. */
export function sectionImporter(module: string, modules: Record<string, Importer> = SECTION_MODULES): Importer | undefined {
  return modules[`./sections/${module}.tsx`];
}
