# Synthetic rendered hint fixture

Imports the actual Phantom `HintNavigation`, settings, model and actual global CSS/reset/bundled fonts.
This isolated Vite server has no application backend, API proxy, authentication,
external data, accounts, conversations or native helper. All controls and draft
text are synthetic. It binds only `127.0.0.1` on a dynamically assigned port.

```sh
npx vite --config tools/keyboard-hints/browser-fixture/vite.config.ts
```

Open its printed localhost URL in a dedicated browser tab. Enable hints using the
fixture checkbox, focus the synthetic editor, and press the configured explicit
chord. Select a displayed label or press Escape. The delayed probe buttons can
change geometry/state or show a harmless modal after entry. The edge/close target
and two-letter options exercise real CSS layout. `Reset synthetic fixture` only
resets this fixture's local state and hint setting on its isolated origin.

Probe controls are deliberately excluded from hint discovery. No synthetic
activation invokes messages, approvals, shell commands, agents or permissions.
