# Phantom front-door captures

Captured 2026-11-14 ET from source `940409cebe32e19cf48dc89ecbf71171dca08a9d` (package candidate 3.30.33), built with `npm run build:web`, Node 22.22.3 and the repository's locked Vite toolchain.

| File | Surface | Data |
| --- | --- | --- |
| `phantom-fleet-demo.png` | Fleet map, provider lanes and agent-message edges | Existing fleet test fixture plus synthetic message edges |
| `phantom-bus-demo.png` | Chat with the Bus pane's durable messages and thread controls | Three synthetic messages and one explicitly illustrative conversation |
| `phantom-workbench-demo.png` | Chat with the Bus pane's dispatch feed | Synthetic coordination events and token-count examples |

All three PNGs are **2880 × 2000**, captured at device scale factor **2**. Fleet uses a 1440 × 1000 viewport scrolled to its map. The other two use a 1440 × 2000 viewport cropped by Chrome to its lower 1440 × 1000 workspace area. Every capture includes an in-page demo-data label. No image was AI-generated, retouched or composited. The landing-page copies are byte-identical to the files here.

These are browser-console captures, **not native desktop app screenshots**. The desktop app hosts the same console, but this capture does not verify native chrome, installation, signing, updater behavior or platform acceptance. A dedicated demo-profile native capture remains follow-up work.

## Capture method

1. Build the current web UI with `npm run build:web`.
2. Load `dist/core/web/public/next/index.html` and its assets in a fresh Chrome profile. Use DevTools request interception to serve only the built assets; fulfill API GETs with fixtures. Refuse all mutations and all unrecognized requests. No live backend or provider is needed.
3. Use `fleetLive`, `authorityStatus`, `fleetControl` and `fleetQueue` from `src/web-ui/routes/verse/command/fixtures.test-support.ts`; use `fleetRunsFixture` from `src/web-ui/routes/verse/fleet/fleet-runs-fixtures.test-support.ts`. Session shapes come from `src/web-ui/routes/verse/fixtures.test-support.ts`. Keep sample projects under `/demo/observatory` and participants prefixed `demo-`.
4. Select the product's dark theme, expand the navigation rail and acknowledge onboarding in the isolated profile. Disable automatic fleet-pane opening in that profile. Open Fleet for the map, or Chat with the Bus pane for the other captures. Switch between Dispatch feed and Durable bus using the actual controls.
5. Add the visible “DEMO DATA · Current source UI · No provider or fleet is running” capture label. Wait for fonts and data to settle; capture with Chrome DevTools at the dimensions above. Check alt text and the generated images before updating the site copies.

The capture used Chrome's debugging pipe because this environment refused loopback connections between tool processes. Unknown/unimplemented fixture reads stayed visibly unavailable; no account readiness was inferred. All three surfaces rendered without uncaught JavaScript exceptions. Sample messages, run phases and counts illustrate rendering only: they are not measurements, real merges or proof of delivered work. No production data, credentials or user conversations were loaded.

The old versioned 3.19–3.24.3 captures remain historical assets for existing links. The current README and site no longer use them as product screenshots.

## Asset checksums

| File | SHA-256 |
| --- | --- |
| `phantom-fleet-demo.png` | `1f3cd0ea77868a061f0c7b247abad7290147c136574110a97309cc58b580c39c` |
| `phantom-bus-demo.png` | `a56866616423af4fa486e4323161e56ccbd4bb1f98073205e0752d6428356bc7` |
| `phantom-workbench-demo.png` | `f616687b68f869825c24e960b97659b3cf8777598f258228bb4cf3a721e7f52a` |
