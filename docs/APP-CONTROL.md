# Control the app from an agent

Use `phm app` for the app controls. RQ-APPCTL-7-AGENTCONTROL adds writes to the existing console, without adding a read API or another MCP server. It references desktop mission-control bc-124196c5 and bc-a46f053b without implementing their screens. Computer automation remains RQ-MACCU-1 (`phm computer`).

Start the existing console with dispatch enabled. Keep its credentials private. Put the console origin and mutation token in a private mode-0600 connection file with fields `url`, `token` (mutation authority), and `readToken` (read authority). The origin must be `http://127.0.0.1:<port>`. Set `PHM_APP_CONNECTION_FILE` to that file's absolute path. Never paste the token into command arguments, documentation, or logs.

With that connection already configured, copy and paste:

```sh
phm app steer pause --json
phm app steer resume --json
phm app prefs '{"memoryEnabled":false}' --json
```

`phm app status`, `resources`, `budgets`, `state`, and `prefs` accept `--json` and reuse existing read routes. Read authorization remains the console's existing boundary. Numeric usage readings are preserved; unavailable or textual readings become `unknown`. No percentage is estimated. Response bodies from failed requests are never printed.

Outside agents POST a request such as `{"version":"app.control.v1","action":"pause"}` to `/api/app/v1/control`, with the existing `x-ashlr-token` header and JSON content type. Actions are `pause`, `resume`, and `prefs`; preferences require an `update` accepted by the existing preference parser. Dispatch must be enabled. `APP_CONTROL_SCHEMA` in `src/core/web/app-control.ts` publishes the JSON schema. The existing stdio MCP bridge advertises `phm_app_control` only when its environment explicitly supplies `PHM_APP_CONNECTION_FILE`. A chat bearer token alone grants no app control.

RQ-AGENTNATIVE-phantom-DESKTOPPREFS: done for existing Verse preferences through `phm app prefs`. This does not claim native OS preferences.
