# Recorded verification commands

The full logs retain original worker settings; the 15-module diagnostic used unit max workers 2. Pristine-baseline command ran in the archived baseline directory. No command changes a test deadline.

```sh
# Evidence: /tmp/recut-final-tests.log
env HOME="$(mktemp -d)" ASHLR_VITEST_UNIT_MAX_WORKERS=1 npm run test:ci -- --maxWorkers=1 --fileParallelism=false test/mcp-native-apps-recovery-history-03sooc1.test.ts test/mcp-native-fleet-apps-follow-03sooj1.test.ts test/mcp-native-recovery-batch-03soow1.test.ts test/mcp-native-recovery-check-03soor1.test.ts test/mcp-native-recovery-wait-03soot1.test.ts test/mcp-native-apps-recovery-integration.test.ts test/fleet-apps-history-api-03sool1.test.ts test/fleet-apps-recovery-verdict-api-03soou1.test.ts test/fleet-apps-recovery-state-03soom1.test.ts test/mcp-native-fleet-apps-status-03-sonj1.test.ts test/mcp-native-fleet-apps-await-03-sonl1.test.ts test/mcp-native-fleet-apps-ensure-03-sonk1.test.ts test/mcp-native-fleet-apps-changes-03-sonn1.test.ts test/m31.contract-lock.test.ts test/m31.safety.test.ts test/docs-mcp-tools.test.ts test/authority-tier1-closure-310b.test.ts test/authority-codeowners-310b.test.ts

# Evidence: /tmp/recut-final-cli-extra.log
env HOME="$(mktemp -d)" ASHLR_VITEST_UNIT_MAX_WORKERS=1 npm run test:ci -- --maxWorkers=1 --fileParallelism=false test/fleet-apps-watch-attempt-budget-03-sonz1.test.ts test/fleet-apps-recovery-wait-03-sooq1.test.ts test/fleet-apps-recovery-wait-stop-03soos1.test.ts

# Evidence: /tmp/recut-cli-regression.log
env HOME="$(mktemp -d)" ASHLR_VITEST_UNIT_MAX_WORKERS=2 npm run test:ci -- test/fleet-apps-follow-delivery-03sooh1.test.ts test/fleet-apps-follow-stop-file-03soog1.test.ts test/fleet-apps-watch-stop-file-03sonf1.test.ts test/fleet-apps-watch-03-sone1.test.ts test/fleet-apps-watch-retry-03-song1.test.ts test/fleet-apps-watch-bus-03-sonu1.test.ts test/fleet-apps-watch-bus-coalesce-03-sonx1.test.ts test/fleet-apps-watch-restart-cap-03-sonw1.test.ts test/fleet-apps-watch-diagnostics-03sony1.test.ts test/fleet-apps-watch-unknown-03-sons1.test.ts test/fleet-apps-follow-03sood1.test.ts test/fleet-apps-follow-root-checkpoint-03sook1.test.ts test/fleet-apps-follow-checkpoint-03soof1.test.ts test/fleet-apps-follow-terminal-03sooe1.test.ts test/fleet-apps-recovery-history-03soob1.test.ts

# Evidence: /tmp/recut-cli-baseline-serial.log
env HOME="$(mktemp -d)" ASHLR_VITEST_UNIT_MAX_WORKERS=1 npm run test:ci -- --no-file-parallelism test/fleet-apps-follow-03sood1.test.ts test/fleet-apps-watch-bus-03-sonu1.test.ts test/fleet-apps-watch-bus-coalesce-03-sonx1.test.ts test/fleet-apps-watch-diagnostics-03sony1.test.ts

# Evidence: /tmp/recut-main-baseline-diagnostics.log
env HOME="$(mktemp -d)" ASHLR_VITEST_UNIT_MAX_WORKERS=1 npm run test:ci -- --no-file-parallelism test/fleet-apps-watch-diagnostics-03sony1.test.ts

node_modules/.bin/tsgo --noEmit
node_modules/.bin/tsgo --noEmit -p src/web-ui/tsconfig.json
npm run typecheck
npm run lint
npm run check:docs
npm run lint:realio-lane
npm run lint:verse-sync-io
node scripts/verify-changed.mjs
```

Final ESLint used `node node_modules/eslint/bin/eslint.js --no-warn-ignored --` followed by every file in `eslint-files.json` (20 paths). The affected real-I/O check uses the existing `runRealioCheck(root, collectChangedPaths(root))` export; the full unchanged guard and baseline comparison were run separately.
