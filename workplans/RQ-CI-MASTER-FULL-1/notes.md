# Notes: Master full CI

The six-hour and reusable tag paths share the complete seven-entry Linux/Windows matrix. Scheduled runs additionally cover Windows service and four Mac job families. Mac general/isolated retain the seven daily slices. Reusable tag push runs no Mac lane, so no additional slice is required. Non-PR classifiers select full: docs/site lanes are skipped on both paths, with docs and web checks inside the full matrix.

Release verify is currently restricted to historical v3.3.2, while release-desktop.yml triggers desktop-v*. Preserve both and all signing authority. Auto-tag needs a separate fail-closed full qualification, because Quick is advisory in the Merge Gate fast-event branch.

No companion MCP tools called. Installed phm 3.30.24 supplied command registry and MCP inventory; gateway status is unwired/unreadable. No credentials resolved.
