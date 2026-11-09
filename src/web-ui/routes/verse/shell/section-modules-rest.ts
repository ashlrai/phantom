/**
 * routes/verse/shell/section-modules-rest.ts — the glob behind every
 * `sections/*Section.tsx` (unit C1), in a chunk of its own.
 *
 * A glob turns each section into an import() thunk plus the preload list of
 * its chunks and styles; that table cost the chat first-paint critical JS
 * ~6 KB for sections the chat never opens. shell/section-modules.ts therefore
 * names the sections statically, imports Chat directly, and reaches this
 * module with one import() the first time any other section is wanted (the
 * after-first-paint warm-up, or a click).
 *
 * THE COST OF A GLOB, paid once: a finished section outside `sections/` is
 * invisible, with nothing failing to say so (MCP shipped that way for a
 * release). section-modules.test.ts pins this table to SECTION_MODULE_NAMES.
 */
type Importer = () => Promise<unknown>;

const RAW: Record<string, Importer> = import.meta.glob('../sections/*Section.tsx');

/** Keys re-based to `./sections/<Module>.tsx`, relative to routes/verse. */
export const REST_SECTION_MODULES: Record<string, Importer> = Object.fromEntries(
  Object.entries(RAW).map(([key, load]) => [key.replace(/^\.\.\//, './'), load]),
);
