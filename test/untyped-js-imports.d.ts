// Ambient `any` declarations for the untyped JavaScript modules the
// backend suites import: operational .mjs/.cjs scripts under scripts/
// and test/helpers that no tsconfig project or sibling .d.mts covers.
// vitest transpiles without type-checking, so those imports are legal
// today; under `tsc --strict` (the verify-changed test-file check,
// scripts/verify-changed.mjs runTestTypecheck) each one is a TS7016
// "could not find a declaration file" error that says nothing about the
// test's own correctness. Declaring the wildcards any is the honest
// type — the modules genuinely carry none — and TypeScript's file
// resolution still wins for every specifier that does resolve to a .ts
// source, so src/ and helper .ts imports keep their real types. Only
// .mjs/.cjs are declared: no backend test imports a real .js file (every
// `.js` specifier resolves to its .ts source), so a `*.js` wildcard
// would only mask genuinely missing modules.
//
// This file must stay a global script (no top-level import/export) for
// the ambient declarations to apply program-wide, and it is always a
// tsc root in runTestTypecheck — never a diagnostic target.
declare module '*.mjs';
declare module '*.cjs';
