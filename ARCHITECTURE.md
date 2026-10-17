# Architecture

Phantom by AshlrAI is the local engineering agent workbench, formerly Ashlr Verse.
The canonical package is `@ashlr/phantom` (compatibility releases through 3.25.3
used `@ashlr/hub`); `phm` and the compatible `ashlr` command share one launcher,
`bin/ashlr`. Existing `~/.ashlr` data and `/verse/` routes remain compatible. See
[docs/PHANTOM-BRAND.md](./docs/PHANTOM-BRAND.md).

This page is a short orientation map. The detailed module map, runtime
boundaries, sandbox model and `~/.ashlr/` layout live in
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

Stack: TypeScript (strict), ESM / NodeNext, Node >= 22.15. `tsc` compiles `src/`
to `dist/`; `bin/ashlr` imports `dist/cli/index.js`. Runtime dependencies are
declared and bundled in `package.json`.

---

## High-level shape

```
bin/ashlr (phm, ashlr) ──▶ dist/cli/index.js ──▶ src/cli/<command>.ts ──▶ src/core/*
                                                                              │
                     state under ~/.ashlr/ (src/core/config.ts) ◀─────────────┤
                                                                              │
phm serve / phm verse ──▶ src/core/web/server.ts (127.0.0.1, default port 7777)
                            ├─ JSON API: src/core/web/api.ts + src/core/verse/verse-api.ts
                            └─ React console: src/web-ui/ (built to /next/, also served at /verse/)

phm mcp ──▶ src/core/mcp-gateway.ts (stdio MCP gateway + native tools)
desktop/ ──▶ Tauri v2 app wrapping the /verse/ console with the CLI as a sidecar
```

---

## Top-level layout

| Path | Contents |
|------|----------|
| `src/cli/` | Command handlers. `src/cli/index.ts` is the argv dispatcher and the canonical command list (`phm help`). |
| `src/core/` | Subsystems: `run/` (orchestrator, sandboxed engines, engine registry), `swarm/`, `fleet/`, `goals/`, `vision/`, `inbox/`, `daemon/`, `sandbox/`, `genome/`, `portfolio/`, `comms/`, `observability/`, `web/`, `verse/`, `universe/`, `resources/`, `local-runtime/`, `authority/` and more. |
| `src/api/` | SDK entrypoints (`@ashlr/phantom`, `/core`, `/types`, `/plugin`; `/universe` maps to `src/core/universe/`). |
| `src/web-ui/` | React web console (Vite, `vite.config.web.ts`). |
| `src/tui/` | Terminal dashboard (`phm tui`). |
| `src/raycast/` | Separate Raycast extension package. |
| `desktop/` | Tauri desktop app ([desktop/README.md](./desktop/README.md)). |
| `schema/` | `config.schema.json` for `~/.ashlr/config.json`. |
| `scripts/`, `test/`, `docs/` | Build/release/check scripts, Vitest suites, documentation. |

## State on disk

General state defaults to `~/.ashlr/`, resolved from `os.homedir()` in
`src/core/config.ts` (`config.json`, `index.json`, `runs/`, `swarms/`, `inbox/`,
`goals/`, `genome/`, `audit/`, the `KILL` switch and more). Universe stores,
Resource Pool ledgers and managed runtime packages use their own explicit roots.
See [the home layout](./docs/ARCHITECTURE.md#the-ashlr-home-layout).

## Build and test

```bash
npm run build       # version check, tsc, assets, web console, release inventory
npm test            # Vitest
npm run test:web    # web console tests
npm run lint        # ESLint and lane checks
npm run typecheck   # tsc --noEmit for backend and web
npm run check:docs  # operator documentation links and anchors
npm run gate        # local release gate
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contracts-first workflow and
[docs/README.md](./docs/README.md) for the full documentation map.
